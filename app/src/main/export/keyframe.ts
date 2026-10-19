/**
 * Export queries using ffprobe to read packets without decoding:
 * 1. Fast stream-copy cuts (pickCopyCut): the nearest video keyframe at or before each segment start, and an end that leaves no gap.
 * 2. Concatenation: measure the intermediate file's actual playback end for the concat list duration (parseMediaEnd).
 * 3. Precise concatenation: detect whether a source has audio and add silence before concatenating when it does not.
 *
 * Stream copy can start only at a keyframe. If `-ss` is set directly to the segment start, ffmpeg copies from the previous keyframe
 * and relies on the MP4 edit list to hide the extra frames; editing software (such as DaVinci) often ignores or mishandles that edit list,
 * causing a black first frame or audio/video desynchronization. Using the concat demuxer's inpoint overlaps the extra packets with the previous segment,
 * producing backward timestamps and stutter. Find the keyframe first so the cut can align to it directly (the UI notes "may add about X seconds").
 */
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'

/** Read a few extra seconds before the start to find a keyframe; ffprobe read_intervals seeks to the keyframe before the start, so at least one is read. */
const LOOKBACK_S = 10
/** Read past the window end to cover sources whose start_time is not 0 (a larger start_time only selects an earlier keyframe, which remains correct). */
const LOOKAHEAD_S = 2
/** How many seconds to read around the end to inspect the B-frame tail. */
const END_WINDOW_S = 2
const PROBE_TIMEOUT_MS = 15_000
const MAX_STDOUT_BYTES = 8 * 1024 * 1024
/** Tolerance for floating-point error (seconds). */
const EPS = 1e-6
/** Treat data as invalid when a keyframe is earlier than 0 by more than this amount after subtracting start_time. */
const MIN_RELATIVE_KEYFRAME_S = -0.1
/** End time offset after the last retained packet when no following packet is found. */
const END_PAD_S = 0.001
/** End audio this many seconds before video playback ends: an AAC packet is about 21–23 ms, and the final packet crosses the cut, so end times differ by about ±10 ms. */
const AUDIO_TAIL_MARGIN_S = 0.01
const MAX_END_PASSES = 32

/** Fast stream-copy cut points (seconds relative to source start_time). */
export interface CopyCut {
  /** Start copying at this keyframe. */
  keyframe: number
  /** End the segment (primarily audio) here: when the last video frame finishes, so no silence appears before the next segment. */
  end: number
  /** Retain video packets only when DTS is below this value (avoids a gap at the B-frame tail); if absent, truncate video at end too. */
  videoCut?: number
}

export type CutLookup = (item: { source: string; start: number; end: number }, signal?: AbortSignal) => Promise<CopyCut | null>

/** ffprobe path lookup: `ADITOR_FFPROBE` → ffprobe beside `ADITOR_FFMPEG` → `ffprobe` on PATH. */
export function defaultFfprobePath(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): string {
  if (env.ADITOR_FFPROBE) return env.ADITOR_FFPROBE
  if (env.ADITOR_FFMPEG) {
    const ext = path.extname(env.ADITOR_FFMPEG)
    const sibling = path.join(path.dirname(env.ADITOR_FFMPEG), `ffprobe${ext}`)
    if (exists(sibling)) return sibling
  }
  return 'ffprobe'
}

/** Two read intervals: 10 seconds before to 2 seconds after the start (find keyframes), and 2 seconds around the end (inspect the tail). Always use absolute end times: `%+N` is relative to the actual seek position and may miss the target area. */
export function cutProbeArgs(source: string, start: number, end: number): string[] {
  const from = Math.max(0, start - LOOKBACK_S)
  const tailFrom = Math.max(0, end - END_WINDOW_S)
  return [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-read_intervals',
    `${from.toFixed(3)}%${(start + LOOKAHEAD_S).toFixed(3)},${tailFrom.toFixed(3)}%${(end + END_WINDOW_S).toFixed(3)}`,
    '-show_entries',
    'packet=pts,dts,flags:stream=time_base:format=start_time',
    '-of',
    'json',
    source
  ]
}

function parseTimeBase(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const m = /^(\d+)\/(\d+)$/.exec(v.trim())
  if (!m) return null
  const num = Number(m[1])
  const den = Number(m[2])
  return num > 0 && den > 0 ? num / den : null
}

interface ProbedPacket {
  pts: number
  dts: number | null
  key: boolean
}

/** Convert ffprobe JSON to packets (seconds relative to start_time); return null for incomplete data. */
function parsePackets(raw: unknown): ProbedPacket[] | null {
  if (typeof raw !== 'object' || raw === null) return null
  const doc = raw as { packets?: unknown; streams?: unknown; format?: { start_time?: unknown } }
  const streams = Array.isArray(doc.streams) ? doc.streams : []
  const tb = parseTimeBase((streams[0] as { time_base?: unknown } | undefined)?.time_base)
  if (tb === null || !Array.isArray(doc.packets)) return null
  const start = Number(doc.format?.start_time)
  const startTime = Number.isFinite(start) ? start : 0
  const out: ProbedPacket[] = []
  for (const p of doc.packets as Array<{ pts?: unknown; dts?: unknown; flags?: unknown }>) {
    const pts = Number(p?.pts)
    if (p?.pts === undefined || !Number.isFinite(pts)) continue
    const dts = Number(p.dts)
    out.push({
      pts: pts * tb - startTime,
      dts: p.dts !== undefined && Number.isFinite(dts) ? dts * tb - startTime : null,
      key: typeof p.flags === 'string' && p.flags.startsWith('K')
    })
  }
  return out
}

function keyframeAtOrBefore(packets: ProbedPacket[], t: number): number | null {
  let best: number | null = null
  for (const p of packets) {
    if (p.key && p.pts <= t + EPS && (best === null || p.pts > best)) best = p.pts
  }
  return best === null || best < MIN_RELATIVE_KEYFRAME_S ? null : best
}

/**
 * Stream-copy `-t` truncates by DTS: with B-frames, the last retained P-frame may display after several discarded B-frames,
 * leaving one or two missing frames at the segment end (a visual jump and audio ending before video, with brief silence before the next segment).
 * Extend the end until no discarded frame has a PTS earlier than the maximum PTS among retained packets (usually only one or two more frames),
 * and place the end between two DTS values to avoid ambiguity when it lands exactly on a packet.
 */
export function cleanCutEnd(packets: ReadonlyArray<{ pts: number; dts: number | null }>, end: number): number {
  const withDts = packets.filter((p): p is { pts: number; dts: number } => p.dts !== null)
  if (withDts.length === 0) return end
  let cut = end
  for (let pass = 0; pass < MAX_END_PASSES; pass++) {
    const kept = withDts.filter((p) => p.dts < cut)
    if (kept.length === 0) return end
    const maxPts = Math.max(...kept.map((p) => p.pts))
    const missing = withDts.filter((p) => p.dts >= cut && p.pts < maxPts - EPS)
    if (missing.length === 0) break
    cut = Math.max(...missing.map((p) => p.dts)) + EPS
  }
  const lastKept = Math.max(...withDts.filter((p) => p.dts < cut).map((p) => p.dts))
  const later = withDts.filter((p) => p.dts > lastKept + EPS).map((p) => p.dts)
  return later.length > 0 ? (lastKept + Math.min(...later)) / 2 : lastKept + END_PAD_S
}

/** Compute fast stream-copy cut points from ffprobe JSON; return null when no keyframe is found or data is invalid (caller uses the conservative method). */
export function pickCopyCut(raw: unknown, start: number, end: number): CopyCut | null {
  const packets = parsePackets(raw)
  if (!packets) return null
  const keyframe = keyframeAtOrBefore(packets, start)
  if (keyframe === null) return null
  // Select packets near the end by DTS (packets duplicated by overlapping read intervals do not affect min/max checks).
  const tail = packets.filter((p) => p.dts !== null && Math.abs(p.dts - end) <= END_WINDOW_S + EPS)
  const videoCut = cleanCutEnd(tail, end)
  const shownEnd = presentationEnd(tail, videoCut)
  if (shownEnd === null) return { keyframe, end: videoCut }
  return { keyframe, end: Math.max(videoCut, shownEnd - AUDIO_TAIL_MARGIN_S), videoCut }
}

/** Playback end of video packets where DTS < cut = maximum PTS + one frame (frame duration is the smallest gap between adjacent PTS values). */
export function presentationEnd(packets: ReadonlyArray<{ pts: number; dts: number | null }>, cut: number): number | null {
  const kept = packets.filter((p) => p.dts !== null && p.dts < cut).map((p) => p.pts)
  if (kept.length === 0) return null
  const sorted = [...new Set(packets.map((p) => p.pts))].sort((a, b) => a - b)
  let frame = Infinity
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i] - sorted[i - 1]
    if (d > EPS && d < frame) frame = d
  }
  return Math.max(...kept) + (Number.isFinite(frame) ? frame : 0)
}

export function createCutLookup(ffprobeBin: string = defaultFfprobePath(), timeoutMs = PROBE_TIMEOUT_MS): CutLookup {
  return (item, signal) =>
    runFfprobe(ffprobeBin, cutProbeArgs(item.source, item.start, item.end), timeoutMs, signal).then((out) => {
      if (out === null) return null
      try {
        return pickCopyCut(JSON.parse(out), item.start, item.end)
      } catch {
        return null
      }
    })
}

/**
 * Actual playback end of a file (seconds) = maximum packet pts + duration.
 * When trimming B-frame sources with stream copy, the last P-frame display time can exceed the MP4 duration (sum of DTS values).
 * If concat demuxer uses that duration for the next segment, two frames share a timestamp at the boundary; use this value in the concat list instead.
 */
export function parseMediaEnd(csv: string): number | null {
  let end: number | null = null
  for (const line of csv.split(/\r?\n/)) {
    const [pts, dur] = line.split(',').map(Number)
    if (!Number.isFinite(pts)) continue
    const e = pts + (Number.isFinite(dur) ? dur : 0)
    if (end === null || e > end) end = e
  }
  return end !== null && end > 0 ? end : null
}

export type MediaEndProbe = (file: string, signal?: AbortSignal) => Promise<number | null>

/** true = has an audio track; false = confirmed no audio; null when the query fails (never replace existing audio with silence). */
export type AudioProbe = (file: string, signal?: AbortSignal) => Promise<boolean | null>

export function createAudioProbe(ffprobeBin: string = defaultFfprobePath(), timeoutMs = PROBE_TIMEOUT_MS): AudioProbe {
  return async (file, signal) => {
    const out = await runFfprobe(ffprobeBin, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=index', '-of', 'csv=p=0', file], timeoutMs, signal)
    if (out === null) return null
    const index = out.trim()
    return index === '' ? false : /^\d+$/.test(index) ? true : null
  }
}

export function createMediaEndProbe(ffprobeBin: string = defaultFfprobePath(), timeoutMs = PROBE_TIMEOUT_MS): MediaEndProbe {
  return (file, signal) =>
    runFfprobe(ffprobeBin, ['-v', 'error', '-show_entries', 'packet=pts_time,duration_time', '-of', 'csv=p=0', file], timeoutMs, signal).then(
      (out) => (out === null ? null : parseMediaEnd(out))
    )
}

/** Run ffprobe and return stdout; return null on non-zero exit, timeout, cancellation, or oversized output. */
function runFfprobe(ffprobeBin: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(null)
    let settled = false
    let stdout = ''
    const proc = spawn(ffprobeBin, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const stop = (): void => {
      try {
        proc.kill()
      } catch {
        // Already exited.
      }
      finish(null)
    }
    const onAbort = (): void => stop()
    const timer = setTimeout(stop, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    proc.stdout?.on('data', (d) => {
      stdout += d.toString()
      if (stdout.length > MAX_STDOUT_BYTES) stop()
    })
    proc.on('error', () => finish(null))
    proc.on('close', (code) => finish(code === 0 ? stdout : null))
  })
}

const PROBE_CONCURRENCY = 4

/** Process in order with at most limit active at once; do not start more after cancellation (unprocessed results are null). */
async function mapLimit<T, R>(inputs: ReadonlyArray<T>, limit: number, fn: (v: T) => Promise<R | null>, signal?: AbortSignal): Promise<Array<R | null>> {
  const results: Array<R | null> = inputs.map(() => null)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < inputs.length && !signal?.aborted) {
      const i = next++
      results[i] = await fn(inputs[i]).catch(() => null)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, worker))
  return results
}

/** Find fast stream-copy cut points for every segment (query identical sources/start/end only once; at most 4 concurrent ffprobe processes). */
export async function lookupCopyCuts(
  items: ReadonlyArray<{ source: string; start: number; end: number }>,
  lookup: CutLookup,
  signal?: AbortSignal
): Promise<Array<CopyCut | null>> {
  const keyOf = (it: { source: string; start: number; end: number }): string => `${it.start}|${it.end}|${it.source}`
  const unique = [...new Map(items.map((it) => [keyOf(it), it] as const)).values()]
  const found = await mapLimit(unique, PROBE_CONCURRENCY, (it) => lookup(it, signal), signal)
  const byKey = new Map(unique.map((it, i) => [keyOf(it), found[i]] as const))
  return items.map((it) => byKey.get(keyOf(it)) ?? null)
}

/** Measure the actual playback end of every intermediate file (at most 4 concurrent ffprobe processes). */
export function measureMediaEnds(files: ReadonlyArray<string>, probe: MediaEndProbe, signal?: AbortSignal): Promise<Array<number | null>> {
  return mapLimit(files, PROBE_CONCURRENCY, (f) => probe(f, signal), signal)
}
