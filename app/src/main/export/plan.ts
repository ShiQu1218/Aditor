import path from 'path'
import { ProjectItem } from '../../renderer/editor/project'
import { estimateOutputBytes as estimateBytes } from '../../shared/exportEstimate'
import { concatCompatible, StreamProbe } from '../../shared/exportCompat'
import type { CopyCut } from './keyframe'
import { tr } from '../../shared/locale'

// 相容性判斷搬到 shared（匯出抽屜在 renderer 也要用）；此處重新匯出維持原 import 路徑
export { concatCompatible, extraSecondsForCopy } from '../../shared/exportCompat'
export type { StreamProbe } from '../../shared/exportCompat'

export interface FfmpegJob {
  args: string[]
  output: string
  tempFiles?: string[]
  /** 中間檔（正規化後的單段）：不算成品，結束後刪除 */
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
  _probes?: Map<string, StreamProbe>
): number {
  return estimateBytes({ items }, quality)
}

export interface BuildJobsOptions {
  mode: 'separate' | 'concat'
  quality: 'copy' | 'precise'
  encoder?: string
  outDir: string
  baseName: string
  /**
   * 快速無損用：每個片段（與 items 同索引）的切點——起點之前最近的關鍵影格與修正後的終點（秒，相對來源 start_time）。
   * 有值就從該關鍵影格精確切；null／缺少時退回保守切法（見 copyCutArgs）。
   */
  copyCuts?: ReadonlyArray<CopyCut | null | undefined>
}

/**
 * ffmpeg 對有 B-frame 的來源、且容器不支援以 PTS seek（如 MP4）時，會把輸入端 `-ss` 往前扣 3/23 秒再 seek
 * （ffmpeg_demux 的 dts heuristic）。關鍵影格就在 `-ss` 前 0.13 秒內時會因此落到「前一個」關鍵影格。
 * 所以 seek 點設為「關鍵影格 + 3/23 秒 + 1 ms」，再用同樣的 `-itsoffset` 把時間戳拉回：輸出時間 0＝該關鍵影格。
 */
const SEEK_DTS_HEURISTIC_S = 3 / 23
const SEEK_MARGIN_S = 0.001
const KEYFRAME_SEEK_PAD_S = SEEK_DTS_HEURISTIC_S + SEEK_MARGIN_S

/** 單一視訊＋第一條音訊（沒有音訊也可以）；不帶來源的章節與中繼資料（MKV 的 DURATION／title 標籤會變成錯誤的 MP4 udta） */
const STREAM_SELECT = ['-map', '0:v:0', '-map', '0:a:0?']
const STRIP_METADATA = ['-map_metadata', '-1', '-map_chapters', '-1']
/**
 * open GOP 來源：關鍵影格之後解碼、顯示時間卻在它之前的 leading B 幀，參考的是前一個 GOP（切掉了），解不出來。
 * 單檔時會被 edit list 藏住，串接時卻會跑到上一段的時間範圍裡；直接丟掉（closed GOP 沒有這種幀，等於不做事）。
 */
const DROP_LEADING_PICTURES = 'lt(pts\\,startpts)'
const AUDIO_AAC = ['-c:a', 'aac', '-b:a', '192k']

const secs = (v: number): string => v.toFixed(3)
const preciseSecs = (v: number): string => v.toFixed(6)
/** 視訊另外在 videoCutRel（相對輸出 0 點的秒數，比較 DTS）截斷，讓音訊多留到視訊最後一幀播完 */
const videoBsf = (videoCutRel?: number): string[] => [
  '-bsf:v',
  `noise=drop=${DROP_LEADING_PICTURES}${videoCutRel === undefined ? '' : `+gte(dts*tb\\,${preciseSecs(videoCutRel)})`}`
]
const durationOf = (item: ProjectItem): string => secs(Math.max(0.1, item.end - item.start))

/**
 * 快速無損切一段：
 * - 已知關鍵影格 K：從 K 開始 stream copy，第一個封包就是關鍵影格且時間戳＝0，不需要 MP4 edit list 藏住多出的畫面；
 *   音訊丟掉 K 之前的封包（`-copypriorss:a 0`），音訊不會比畫面早開始；視訊截在 cut.videoCut（B-frame 尾端不留空洞），
 *   音訊截在 cut.end（視訊最後一幀播完），接下一段時不會出現一段無聲。
 * - 不知道 K：照舊從片段起點 seek（ffmpeg 會退到前一個關鍵影格），再以 `-avoid_negative_ts make_zero`
 *   把整段平移到 0 起算，同樣不留 edit list 跳過畫面。
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

/** 實際採用的品質：合輯＋快速無損但來源規格不相容時自動改成精準（附提示）。 */
export function resolveQuality(
  items: ProjectItem[],
  opts: Pick<BuildJobsOptions, 'mode' | 'quality'>,
  probes: Map<string, StreamProbe>
): { quality: 'copy' | 'precise'; notices: string[] } {
  if (opts.mode === 'concat' && opts.quality === 'copy') {
    // 同一來源只比對一次
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
    // -ss 放在 -i 前面：轉碼時同樣是精準 seek，但不必從檔頭解碼到起點（I8）
    const args = ['-ss', secs(item.start), '-i', item.source, '-t', durationOf(item), ...STREAM_SELECT, '-c:v', opts.encoder!, ...AUDIO_AAC, ...STRIP_METADATA, '-y', output]
    return { args, output }
  })
  return { jobs, notices }
}

const segmentTag = (): string => Math.random().toString(36).slice(2, 8)
const segmentPath = (outDir: string, tag: string, idx: number, ext: string): string => path.join(outDir, `.apexhl-seg-${tag}-${idx + 1}${ext}`)

/**
 * concat demuxer 清單。有量到每段實際播放終點（見 keyframe.ts 的 parseMediaEnd）就加上 `duration`，
 * 讓下一段精確接在上一段最後一幀之後，不依賴 MP4 以 DTS 加總、可能偏短的 duration。
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
 * 串接中間檔的輸入。`-copyts`：concat 輸入的 start_time 是 ffmpeg 從各流第一個時間戳估的（某些編碼的視訊估不出來，
 * 就只剩音訊的起點，例如 0.013 秒），不加的話整條時間軸會被平移，視訊第一幀變成負時間、被 edit list 藏掉。
 * 中間檔本來就都從 0 起算，直接沿用它們的時間戳。
 */
const CONCAT_INPUT = ['-copyts', '-f', 'concat', '-safe', '0', '-i', 'LIST_FILE_PLACEHOLDER']
const listOf = (jobs: FfmpegJob[]): string => concatList(jobs.map((j) => j.output))

/**
 * 快速無損合輯：不用 concat demuxer 的 inpoint／outpoint 直接讀來源——長 GOP 編碼時 inpoint 前會多吐出一段
 * 從前一個關鍵影格起的封包，時間戳與上一段重疊（Non-monotonic DTS），播放器在交界卡住、音訊多出來而不同步。
 * 改成每段先從關鍵影格 stream copy 成中間檔（每段都從 0 起、第一幀是關鍵影格），最後 concat demuxer 直接接起來。
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

function needsNormalize(items: ProjectItem[], probes: Map<string, StreamProbe>): boolean {
  const sources = [...new Set(items.map((it) => it.source))]
  if (sources.length <= 1) return false
  const list = sources.map((src) => probes.get(src)).filter((p): p is StreamProbe => !!p)
  return list.length < sources.length || !concatCompatible(list).ok
}

function normalizeFilter(items: ProjectItem[], probes: Map<string, StreamProbe>): string {
  const first = probes.get(items[0].source)
  const w = first && first.width > 0 ? first.width : 1920
  const h = first && first.height > 0 ? first.height : 1080
  const fps = first && first.fps > 0 ? first.fps : 60
  return [`scale=${w}:${h}:force_original_aspect_ratio=decrease`, `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`, `fps=${fps}`, 'format=yuv420p'].join(',')
}

/**
 * 精準合輯：每段以 `-ss`（輸入端，精準 seek）轉成中間檔，最後 concat demuxer 接起來、視訊直接 copy、音訊整條一次編成 AAC。
 * - 不用 inpoint 直接轉碼來源：inpoint 前的音訊封包也會被解碼進去，每個交界多出最多一個 GOP 長度的聲音，影音越來越不同步。
 * - 中間檔音訊用 PCM（.mov）：AAC 每段都有 1024 樣本的 priming，串接後交界的音訊時間戳倒退、
 *   成品第一條視訊軌還會多一段空白 edit（剪輯軟體顯示為第一幀全黑）。PCM 沒有 priming，最後只編一次 AAC。
 * - 多來源且規格不一定相同時才加 scale／pad／fps／format 正規化（concat 需要每段規格一致）；
 *   同一來源的片段規格本來就一致，不改幀率與解析度。
 */
function buildPreciseConcat(
  items: ProjectItem[],
  opts: BuildJobsOptions,
  probes: Map<string, StreamProbe>,
  notices: string[]
): { jobs: FfmpegJob[]; notices: string[]; concatListContent: string } {
  const normalize = needsNormalize(items, probes)
  const vf = normalize ? ['-vf', normalizeFilter(items, probes)] : []
  const tag = segmentTag()
  const segments: FfmpegJob[] = items.map((item, idx) => {
    const output = segmentPath(opts.outDir, tag, idx, '.mov')
    return {
      intermediate: true,
      output,
      args: ['-ss', secs(item.start), '-i', item.source, '-t', durationOf(item), ...STREAM_SELECT, ...vf, '-c:v', opts.encoder!, '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', ...STRIP_METADATA, '-y', output]
    }
  })
  const output = path.join(opts.outDir, `${opts.baseName}.mp4`)
  const final: FfmpegJob = {
    output,
    // aresample async：某段沒有音訊時以靜音補上空檔，後面的聲音不會往前擠
    args: [...CONCAT_INPUT, ...STREAM_SELECT, '-c:v', 'copy', '-af', 'aresample=async=1:first_pts=0', ...AUDIO_AAC, '-y', output]
  }
  const allNotices = normalize ? [...notices, tr('來源規格不同，已先將每段轉成相同規格再合併')] : notices
  return { jobs: [...segments, final], notices: allNotices, concatListContent: listOf(segments) }
}

/**
 * 找一個不會覆蓋既有檔案的檔名主體（I6）：依序嘗試 `<base>`、`<base> (2)`、`<base> (3)`…，
 * 直到該模式會產生的所有輸出檔都不存在。
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
