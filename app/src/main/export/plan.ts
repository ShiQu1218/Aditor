import path from 'path'
import { ProjectItem } from '../../renderer/editor/project'
import { estimateOutputBytes as estimateBytes } from '../../shared/exportEstimate'
import { concatCompatible, StreamProbe } from '../../shared/exportCompat'
import type { CopyCut } from './keyframe'
import { sourceSpec, concatRenderSpec, videoEncodeArgs, type VideoSpec } from './encodeQuality'
import { tr } from '../../shared/locale'

// Compatibility checks live in shared (the renderer's export drawer also uses them); re-export here to preserve the existing import path.
export { concatCompatible, extraSecondsForCopy } from '../../shared/exportCompat'
export type { StreamProbe } from '../../shared/exportCompat'

export interface FfmpegJob {
  args: string[]
  output: string
  tempFiles?: string[]
  /** Intermediate file (a normalized segment): not a final output and deleted after the job. */
  intermediate?: boolean
}

export class NoEncoderError extends Error {
  constructor(message = 'No video encoder available for precise export') {
    super(message)
    this.name = 'NoEncoderError'
  }
}

export function escapeConcatPath(filePath: string): string {
  // Concat demuxer expects single quotes around path and single quotes escaped as '\'\''
  const normalized = filePath.replace(/\\/g, '/')
  const escaped = normalized.replace(/'/g, "'\\''")
  return `'${escaped}'`
}

export function estimateOutputBytes(
  items: ProjectItem[],
  quality: 'copy' | 'precise',
  probes?: Map<string, StreamProbe>,
  mode: 'concat' | 'separate' = 'concat'
): number {
  return estimateBytes({ items }, quality, probes, mode)
}

export interface BuildJobsOptions {
  mode: 'separate' | 'concat'
  quality: 'copy' | 'precise'
  encoder?: string
  outDir: string
  baseName: string
  /**
   * For fast stream copy: cut points for each segment (same index as items)—the nearest keyframe before the start and adjusted end (seconds relative to source start_time).
   * When present, cut exactly from that keyframe; when null/missing, use the conservative method (see copyCutArgs).
   */
  copyCuts?: ReadonlyArray<CopyCut | null | undefined>
  /** Precise concatenation: add equal-length silence to sources known to have no audio track, keeping streams consistent. */
  silentSources?: ReadonlySet<string>
}

/**
 * For B-frame sources in containers that do not support PTS seeking (such as MP4), ffmpeg moves input `-ss` back by 3/23 seconds
 * before seeking (ffmpeg_demux's dts heuristic). If a keyframe is within 0.13 seconds before `-ss`, this can select the previous keyframe.
 * Set the seek point to "keyframe + 3/23 seconds + 1 ms", then use the same `-itsoffset` to restore timestamps so output time 0 is that keyframe.
 */
const SEEK_DTS_HEURISTIC_S = 3 / 23
const SEEK_MARGIN_S = 0.001
const KEYFRAME_SEEK_PAD_S = SEEK_DTS_HEURISTIC_S + SEEK_MARGIN_S

/** One video stream plus the first audio stream (audio is optional); omit source chapters and metadata (MKV DURATION/title tags become invalid MP4 udta). */
const STREAM_SELECT = ['-map', '0:v:0', '-map', '0:a:0?']
const STRIP_METADATA = ['-map_metadata', '-1', '-map_chapters', '-1']
/**
 * In open-GOP sources, leading B-frames decoded after a keyframe but displayed before it reference the previous GOP (which was cut away) and cannot be decoded.
 * They are hidden by the edit list in a single file but can fall into the previous segment's time range after concatenation; drop them directly (closed GOPs have none, so this has no effect).
 */
const DROP_LEADING_PICTURES = 'lt(pts\\,startpts)'
const AUDIO_AAC = ['-c:a', 'aac', '-b:a', '192k']

const secs = (v: number): string => v.toFixed(3)
const preciseSecs = (v: number): string => v.toFixed(6)
/** Truncate video separately at videoCutRel (seconds relative to output time 0, compared by DTS), allowing audio to last until the final video frame finishes. */
const videoBsf = (videoCutRel?: number): string[] => [
  '-bsf:v',
  `noise=drop=${DROP_LEADING_PICTURES}${videoCutRel === undefined ? '' : `+gte(dts*tb\\,${preciseSecs(videoCutRel)})`}`
]
const durationOf = (item: ProjectItem): string => secs(Math.max(0.1, item.end - item.start))

/**
 * Fast stream-copy a segment:
 * - Known keyframe K: start copying from K, making the first packet a keyframe with timestamp 0; no MP4 edit list is needed to hide extra frames.
 *   Drop audio packets before K (`-copypriorss:a 0`) so audio does not start before video; truncate video at cut.videoCut (no gap at the B-frame tail),
 *   and audio at cut.end (when the final video frame finishes), avoiding silence before the next segment.
 * - Unknown K: seek from the segment start as before (ffmpeg backs up to the previous keyframe), then shift the whole segment to start at 0 with `-avoid_negative_ts make_zero`,
 *   also avoiding an edit list that skips frames.
 */
function usableCut(item: ProjectItem, cut: CopyCut | null | undefined): cut is CopyCut {
  if (!cut || !Number.isFinite(cut.keyframe) || !Number.isFinite(cut.end)) return false
  return cut.keyframe <= item.start && cut.keyframe > -KEYFRAME_SEEK_PAD_S && cut.end > cut.keyframe
}

export function copyCutArgs(item: ProjectItem, cut: CopyCut | null | undefined, output: string): string[] {
  if (usableCut(item, cut)) {
    const { keyframe } = cut
    const videoCut = cut.videoCut !== undefined && Number.isFinite(cut.videoCut) && cut.videoCut < cut.end ? cut.videoCut - keyframe : undefined
    return [
      '-ss',
      preciseSecs(keyframe + KEYFRAME_SEEK_PAD_S),
      '-itsoffset',
      preciseSecs(KEYFRAME_SEEK_PAD_S),
      '-i',
      item.source,
      '-t',
      preciseSecs(cut.end - keyframe),
      ...STREAM_SELECT,
      '-c',
      'copy',
      ...videoBsf(videoCut),
      '-copypriorss:a',
      '0',
      ...STRIP_METADATA,
      '-y',
      output
    ]
  }
  return [
    '-ss',
    secs(item.start),
    '-i',
    item.source,
    '-t',
    durationOf(item),
    ...STREAM_SELECT,
    '-c',
    'copy',
    ...videoBsf(),
    '-avoid_negative_ts',
    'make_zero',
    ...STRIP_METADATA,
    '-y',
    output
  ]
}

/** Actual quality used: for concatenation with fast stream copy, automatically switch to precise when source specs are incompatible (with a notice). */
export function resolveQuality(
  items: ProjectItem[],
  opts: Pick<BuildJobsOptions, 'mode' | 'quality'>,
  probes: Map<string, StreamProbe>
): { quality: 'copy' | 'precise'; notices: string[] } {
  if (opts.mode === 'concat' && opts.quality === 'copy') {
    // Compare each source only once.
    const probeList = [...new Set(items.map((it) => it.source))].map((src) => probes.get(src)).filter((p): p is StreamProbe => !!p)
    const check = concatCompatible(probeList)
    if (!check.ok) {
      return { quality: 'precise', notices: [tr('影片規格不相容（{reason}），已自動切換為精準轉碼模式', { reason: check.reason })] }
    }
  }
  return { quality: opts.quality, notices: [] }
}

export function buildJobs(
  items: ProjectItem[],
  opts: BuildJobsOptions,
  probes: Map<string, StreamProbe>
): { jobs: FfmpegJob[]; notices: string[]; concatListContent?: string } {
  const { quality, notices } = resolveQuality(items, opts, probes)

  if (quality === 'precise' && !opts.encoder) {
    throw new NoEncoderError()
  }

  if (opts.mode === 'concat') {
    return quality === 'copy' ? buildCopyConcat(items, opts, notices) : buildPreciseConcat(items, opts, probes, notices)
  }

  const jobs: FfmpegJob[] = items.map((item, idx) => {
    const output = path.join(opts.outDir, `${opts.baseName}_${idx + 1}.mp4`)
    if (quality === 'copy') return { args: copyCutArgs(item, opts.copyCuts?.[idx], output), output }
    // Put -ss before -i: precise seeking when transcoding, without decoding from the start of the file to the cut (I8).
    const video = videoEncodeArgs(opts.encoder!, sourceSpec(probes.get(item.source)))
    const args = ['-ss', secs(item.start), '-i', item.source, '-t', durationOf(item), ...STREAM_SELECT, ...video, ...AUDIO_AAC, ...STRIP_METADATA, '-y', output]
    return { args, output }
  })
  return { jobs, notices }
}

const segmentTag = (): string => Math.random().toString(36).slice(2, 8)
const segmentPath = (outDir: string, tag: string, idx: number, ext: string): string => path.join(outDir, `.aditor-seg-${tag}-${idx + 1}${ext}`)

/**
 * Build a concat demuxer list. When the actual playback end of each segment was measured (see parseMediaEnd in keyframe.ts), add `duration`
 * so the next segment starts exactly after the previous segment's last frame instead of relying on MP4 duration summed from DTS, which may be too short.
 */
export function concatList(files: ReadonlyArray<string>, durations: ReadonlyArray<number | null | undefined> = []): string {
  const lines: string[] = []
  files.forEach((f, i) => {
    lines.push(`file ${escapeConcatPath(f)}`)
    const d = durations[i]
    if (d !== null && d !== undefined && Number.isFinite(d) && d > 0) lines.push(`duration ${d.toFixed(6)}`)
  })
  return lines.join('\n') + '\n'
}

/**
 * Input for concatenating intermediate files. `-copyts`: ffmpeg estimates concat input start_time from the first timestamp of each stream (for some video codecs it cannot estimate one,
 * leaving only the audio start, such as 0.013 seconds). Without this flag, the whole timeline shifts, the first video frame gets a negative timestamp, and the edit list hides it.
 * Intermediate files already start at 0, so keep their timestamps as-is.
 */
const CONCAT_INPUT = ['-copyts', '-f', 'concat', '-safe', '0', '-i', 'LIST_FILE_PLACEHOLDER']
const listOf = (jobs: FfmpegJob[]): string => concatList(jobs.map((j) => j.output))

/**
 * Fast stream-copy concatenation: do not read sources directly with concat demuxer inpoint/outpoint. With long-GOP encoding, packets from the previous keyframe
 * before the inpoint overlap the prior segment's timestamps (Non-monotonic DTS), causing playback to stall at the boundary and audio to overrun and desynchronize.
 * Instead, stream-copy each segment from a keyframe into an intermediate file (each starts at 0 with a keyframe as its first frame), then join them with the concat demuxer.
 */
function buildCopyConcat(
  items: ProjectItem[],
  opts: BuildJobsOptions,
  notices: string[]
): { jobs: FfmpegJob[]; notices: string[]; concatListContent: string } {
  const tag = segmentTag()
  const segments: FfmpegJob[] = items.map((item, idx) => {
    const output = segmentPath(opts.outDir, tag, idx, '.mp4')
    return { intermediate: true, output, args: copyCutArgs(item, opts.copyCuts?.[idx], output) }
  })
  const output = path.join(opts.outDir, `${opts.baseName}.mp4`)
  const final: FfmpegJob = {
    output,
    args: [...CONCAT_INPUT, ...STREAM_SELECT, '-c', 'copy', '-y', output]
  }
  return { jobs: [...segments, final], notices, concatListContent: listOf(segments) }
}

/** Fit each segment into the timeline spec with Lanczos scaling (sharper than the default bicubic), letterboxing any aspect mismatch. */
function normalizeFilter({ width: w, height: h, fps }: VideoSpec): string {
  return [`scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos`, `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`, `fps=${fps}`, 'format=yuv420p'].join(',')
}

/**
 * Precise concatenation: transcode each segment to an intermediate file using input-side `-ss` (precise seek), then join with concat demuxer, copying video and encoding the full audio stream to AAC once.
 * - Do not transcode sources directly with inpoint: audio packets before the inpoint are decoded too, adding up to one GOP of sound at each boundary and increasing A/V desynchronization.
 * - Use PCM audio in intermediate .mov files: each AAC segment has 1024 samples of priming, which makes audio timestamps go backward at joins and adds a blank edit to the first video track
 *   (editing software displays a black first frame). PCM has no priming, so encode AAC only once at the end.
 * - Add scale/pad/fps/format normalization only when sources may have different specs (concat requires matching specs for every segment);
 *   clips from the same source already match, so do not change frame rate or resolution.
 */
function buildPreciseConcat(
  items: ProjectItem[],
  opts: BuildJobsOptions,
  probes: Map<string, StreamProbe>,
  notices: string[]
): { jobs: FfmpegJob[]; notices: string[]; concatListContent: string } {
  const { spec, normalize } = concatRenderSpec([...new Set(items.map((it) => it.source))].map((src) => probes.get(src)))
  const vf = normalize ? ['-vf', normalizeFilter(spec)] : []
  const video = videoEncodeArgs(opts.encoder!, spec)
  const tag = segmentTag()
  const segments: FfmpegJob[] = items.map((item, idx) => {
    const output = segmentPath(opts.outDir, tag, idx, '.mov')
    const silent = opts.silentSources?.has(item.source) === true
    const audioInput = silent ? ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'] : []
    const streams = silent ? ['-map', '0:v:0', '-map', '1:a:0'] : STREAM_SELECT
    return {
      intermediate: true,
      output,
      args: ['-ss', secs(item.start), '-i', item.source, ...audioInput, '-t', durationOf(item), ...streams, ...vf, ...video, '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', ...(silent ? ['-shortest'] : []), ...STRIP_METADATA, '-y', output]
    }
  })
  const output = path.join(opts.outDir, `${opts.baseName}.mp4`)
  const final: FfmpegJob = {
    output,
    // Fill small gaps in audio timestamps; sources without audio already have silence in their intermediate files.
    args: [...CONCAT_INPUT, ...STREAM_SELECT, '-c:v', 'copy', '-af', 'aresample=async=1:first_pts=0', ...AUDIO_AAC, '-y', output]
  }
  const allNotices = normalize ? [...notices, tr('來源規格不同，已先將每段轉成相同規格再合併')] : notices
  return { jobs: [...segments, final], notices: allNotices, concatListContent: listOf(segments) }
}

/**
 * Find a filename stem that does not overwrite existing files (I6): try `<base>`, `<base> (2)`, `<base> (3)`…
 * until none of the output files for that mode exist.
 */
export function resolveFreeBaseName(
  outDir: string,
  baseName: string,
  mode: 'separate' | 'concat',
  count: number,
  exists: (p: string) => boolean
): { baseName: string; renamed: boolean } {
  const outputs = (b: string): string[] =>
    mode === 'separate' ? Array.from({ length: count }, (_, i) => path.join(outDir, `${b}_${i + 1}.mp4`)) : [path.join(outDir, `${b}.mp4`)]
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? baseName : `${baseName} (${n})`
    if (!outputs(candidate).some(exists)) return { baseName: candidate, renamed: n > 1 }
  }
  return { baseName: `${baseName} (${Date.now()})`, renamed: true }
}
