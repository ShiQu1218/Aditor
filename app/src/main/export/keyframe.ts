/**
 * 匯出用、以 ffprobe 只讀封包（不解碼）的查詢：
 * 1. 快速無損切點（pickCopyCut）：片段起點（含）之前最近的視訊關鍵影格，以及不會在尾端留下空洞的終點。
 * 2. 合輯：量中間檔實際播放到的終點，作為 concat 清單的 duration（parseMediaEnd）。
 *
 * stream copy 只能從關鍵影格開始。若直接用片段起點 `-ss`，ffmpeg 會從前一個關鍵影格開始複製，
 * 再靠 MP4 edit list 把多出的畫面「藏起來」；剪輯軟體（DaVinci 等）常不理會或處理錯 edit list，
 * 造成第一幀黑畫面、影音不同步；用 concat demuxer 的 inpoint 則會把多出的封包與前一段重疊，
 * 時間戳倒退而卡頓。先查到關鍵影格，切點就能直接對齊它（介面已提示「可能多出約 X 秒」）。
 */
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'

/** 往前多讀幾秒找關鍵影格；ffprobe 的 read_intervals 會先 seek 到起點之前的關鍵影格，所以一定至少讀到一個。 */
const LOOKBACK_S = 10
/** 視窗終點多讀一點，涵蓋來源 start_time 不為 0 的情況（start_time 更大時只會選到較早的關鍵影格，仍然正確） */
const LOOKAHEAD_S = 2
/** 終點附近讀多少秒來判斷 B-frame 尾端 */
const END_WINDOW_S = 2
const PROBE_TIMEOUT_MS = 15_000
const MAX_STDOUT_BYTES = 8 * 1024 * 1024
/** 浮點誤差容許值（秒） */
const EPS = 1e-6
/** 關鍵影格（扣掉 start_time 後）比 0 還早超過這個值就視為資料異常 */
const MIN_RELATIVE_KEYFRAME_S = -0.1
/** 找不到下一個封包時，終點放在最後一個保留封包之後多少秒 */
const END_PAD_S = 0.001
/** 音訊截在視訊播完前這麼多秒：AAC 一個封包約 21～23 ms，最後一個封包會跨過截點，兩者結束時間相差約 ±10 ms */
const AUDIO_TAIL_MARGIN_S = 0.01
const MAX_END_PASSES = 32

/** 快速無損切點（秒，相對來源 start_time） */
export interface CopyCut {
  /** 從這個關鍵影格開始 copy */
  keyframe: number
  /** 整段（主要是音訊）在這裡結束：視訊最後一幀播完的時間，讓下一段接上時不會有一段無聲 */
  end: number
  /** 視訊封包只保留 DTS 小於此值的（B-frame 尾端不留空洞）；沒有時視訊也以 end 截斷 */
  videoCut?: number
}

export type CutLookup = (item: { source: string; start: number; end: number }, signal?: AbortSignal) => Promise<CopyCut | null>

/** ffprobe 路徑：`APEXHL_FFPROBE` → `APEXHL_FFMPEG` 同目錄的 ffprobe → PATH 上的 `ffprobe`。 */
export function defaultFfprobePath(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): string {
  if (env.APEXHL_FFPROBE) return env.APEXHL_FFPROBE
  if (env.APEXHL_FFMPEG) {
    const ext = path.extname(env.APEXHL_FFMPEG)
    const sibling = path.join(path.dirname(env.APEXHL_FFMPEG), `ffprobe${ext}`)
    if (exists(sibling)) return sibling
  }
  return 'ffprobe'
}

/** 兩個讀取區間：起點前 10 秒～起點後 2 秒（找關鍵影格）、終點前後 2 秒（檢查尾端）。終點一律用絕對時間：`%+N` 是從實際 seek 到的位置起算，可能讀不到目標附近。 */
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

/** ffprobe JSON → 封包（秒，相對 start_time）；資料不完整回傳 null */
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
 * stream copy 的 `-t` 以 DTS 截斷：有 B-frame 時，最後保留的 P 幀顯示時間可能晚於幾個被截掉的 B 幀，
 * 片段尾端就少了一兩幀（畫面跳一下、音訊比畫面早結束，接下一段時出現短暫無聲）。
 * 這裡把終點往後延到「已保留封包中最大的 PTS 之前，沒有任何被截掉的幀」為止（通常只多一兩幀），
 * 並把終點放在兩個 DTS 中間，避免剛好落在某個封包上時 ffmpeg 取捨不定。
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

/** 從 ffprobe JSON 算出快速無損切點；找不到關鍵影格或資料異常時回傳 null（呼叫端改用保守的切法）。 */
export function pickCopyCut(raw: unknown, start: number, end: number): CopyCut | null {
  const packets = parsePackets(raw)
  if (!packets) return null
  const keyframe = keyframeAtOrBefore(packets, start)
  if (keyframe === null) return null
  // 依 DTS 取終點附近的封包（兩個讀取區間重疊時封包會重複，不影響最大／最小值的判斷）
  const tail = packets.filter((p) => p.dts !== null && Math.abs(p.dts - end) <= END_WINDOW_S + EPS)
  const videoCut = cleanCutEnd(tail, end)
  const shownEnd = presentationEnd(tail, videoCut)
  if (shownEnd === null) return { keyframe, end: videoCut }
  return { keyframe, end: Math.max(videoCut, shownEnd - AUDIO_TAIL_MARGIN_S), videoCut }
}

/** DTS < cut 的視訊封包播完的時間＝最大 PTS＋一幀（幀長取相鄰 PTS 的最小間隔） */
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
 * 檔案實際播放到的終點（秒）＝所有封包 pts＋duration 的最大值。
 * B-frame 來源以 stream copy 切尾時，最後一個 P 幀的顯示時間會晚於 MP4 記錄的 duration（以 DTS 加總），
 * concat demuxer 若用那個 duration 接下一段，交界會有兩幀同一個時間戳；所以合輯清單改用這個值。
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

export function createMediaEndProbe(ffprobeBin: string = defaultFfprobePath(), timeoutMs = PROBE_TIMEOUT_MS): MediaEndProbe {
  return (file, signal) =>
    runFfprobe(ffprobeBin, ['-v', 'error', '-show_entries', 'packet=pts_time,duration_time', '-of', 'csv=p=0', file], timeoutMs, signal).then(
      (out) => (out === null ? null : parseMediaEnd(out))
    )
}

/** 執行 ffprobe 取 stdout；非 0 結束、逾時、中止或輸出過大都回傳 null。 */
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
        // 已結束
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

/** 依序處理，最多同時 limit 個；中止後不再開始新的（未處理的結果為 null）。 */
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

/** 查每個片段的快速無損切點（相同來源與起訖只查一次，最多同時 4 個 ffprobe）。 */
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

/** 量每個中間檔的實際播放終點（最多同時 4 個 ffprobe）。 */
export function measureMediaEnds(files: ReadonlyArray<string>, probe: MediaEndProbe, signal?: AbortSignal): Promise<Array<number | null>> {
  return mapLimit(files, PROBE_CONCURRENCY, (f) => probe(f, signal), signal)
}
