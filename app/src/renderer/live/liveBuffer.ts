/**
 * 錄影中觀看的 MSE 段落佇列（不依賴 DOM，可用假 SourceBuffer 測試）。
 *
 * - 先 append init.mp4，之後挑播放頭附近（後 BEHIND／前 AHEAD 秒）尚未緩衝的段落依時間順序 append；
 *   一次只做一個操作，等 `updateend` 再做下一個。`mode = 'segments'`：段落依自己的時間戳放置。
 * - 只保留最近 RETAIN_SEC（30 分鐘）：更早的緩衝以 `remove()` 釋放；瀏覽器回報配額不足時
 *   先移除播放頭之前的資料，下一輪再抓。
 * - 不一次載入整段錄影：高位元率錄影 30 分鐘遠超過 MSE 配額，只抓播放頭附近，拖曳／跳轉時再抓。
 */
import type { LiveSegment } from '../../shared/recording'

export const RETAIN_SEC = 30 * 60
export const AHEAD_SEC = 8
export const BEHIND_SEC = 2
/** 跳到最新時停在最新段落結尾前幾秒（給解碼器一點緩衝）。 */
export const LIVE_EDGE_OFFSET = 3
const MAX_FAILURES = 3

export interface TimeRangesLike {
  readonly length: number
  start(index: number): number
  end(index: number): number
}

export interface SourceBufferLike {
  mode: string
  readonly updating: boolean
  readonly buffered: TimeRangesLike
  appendBuffer(data: Uint8Array): void
  remove(start: number, end: number): void
  addEventListener(type: 'updateend', listener: () => void): void
  removeEventListener(type: 'updateend', listener: () => void): void
}

export interface LiveBufferOptions {
  sourceBuffer: SourceBufferLike
  fetchInit: () => Promise<Uint8Array>
  fetchSegment: (seq: number) => Promise<Uint8Array>
  currentTime: () => number
  /** 緩衝閒置時呼叫，讓 MediaSource.duration 跟著錄影增長 */
  setDuration?: (seconds: number) => void
  onError?: (error: unknown) => void
}

export function covers(ranges: TimeRangesLike, t: number): boolean {
  for (let i = 0; i < ranges.length; i++) if (ranges.start(i) <= t && t < ranges.end(i)) return true
  return false
}

export class LiveBuffer {
  private segments: LiveSegment[] = []
  private appended = new Set<number>()
  private failures = new Map<number, number>()
  private initFailures = 0
  private initDone = false
  private busy = false
  private disposed = false
  private readonly onUpdateEnd = (): void => {
    this.busy = false
    this.pump()
  }

  constructor(private options: LiveBufferOptions) {
    options.sourceBuffer.mode = 'segments'
    options.sourceBuffer.addEventListener('updateend', this.onUpdateEnd)
  }

  setSegments(list: LiveSegment[]): void {
    this.segments = [...list].sort((a, b) => a.pts - b.pts)
    this.pump()
  }

  addSegment(segment: LiveSegment): void { this.setSegments([...this.segments.filter(s => s.seq !== segment.seq), segment]) }

  /** 錄影目前的結尾（秒）。 */
  liveEnd(): number {
    const last = this.segments[this.segments.length - 1]
    return last ? last.pts + last.dur : 0
  }

  /** 保留範圍起點：更早的內容已釋放（收尾後請在工作室觀看）。 */
  retainStart(): number { return Math.max(0, this.liveEnd() - RETAIN_SEC) }

  /** 拖曳／停頓後呼叫：瀏覽器可能自行回收了緩衝，重新檢查哪些段落要再抓。 */
  revalidate(): void {
    const ranges = this.options.sourceBuffer.buffered
    for (const segment of this.segments) {
      if (this.appended.has(segment.seq) && !covers(ranges, segment.pts + segment.dur / 2)) this.appended.delete(segment.seq)
    }
    this.pump()
  }

  dispose(): void {
    this.disposed = true
    this.options.sourceBuffer.removeEventListener('updateend', this.onUpdateEnd)
  }

  pump(): void {
    const sb = this.options.sourceBuffer
    if (this.disposed || this.busy || sb.updating) return
    if (!this.initDone) {
      if (this.initFailures < MAX_FAILURES) this.loadInit()
      return
    }
    this.options.setDuration?.(this.liveEnd())
    const retain = this.retainStart()
    if (sb.buffered.length > 0 && sb.buffered.start(0) < retain - 1) {
      this.removeRange(sb.buffered.start(0), retain)
      return
    }
    const next = this.nextSegment(retain)
    if (next) this.loadSegment(next)
  }

  private loadInit(): void {
    this.busy = true
    this.options.fetchInit().then((bytes) => {
      if (this.disposed) return
      this.initDone = true
      this.options.sourceBuffer.appendBuffer(bytes)
    }).catch((error) => {
      this.initFailures++
      this.busy = false
      this.options.onError?.(error)
    })
  }

  private loadSegment(segment: LiveSegment): void {
    this.busy = true
    this.options.fetchSegment(segment.seq).then((bytes) => {
      if (this.disposed) return
      if (!this.segments.some(s => s.seq === segment.seq)) { this.busy = false; this.pump(); return }
      this.options.sourceBuffer.appendBuffer(bytes)
      this.appended.add(segment.seq)
    }).catch((error) => {
      if (this.disposed) return
      this.busy = false
      if (!this.segments.some(s => s.seq === segment.seq)) { this.pump(); return }
      this.failures.set(segment.seq, (this.failures.get(segment.seq) ?? 0) + 1)
      if ((error as DOMException)?.name === 'QuotaExceededError') {
        // 配額不足：釋放播放頭之前的資料，下一輪（updateend）再抓這段。
        const ranges = this.options.sourceBuffer.buffered
        const cut = this.options.currentTime() - BEHIND_SEC
        if (ranges.length > 0 && ranges.start(0) < cut) this.removeRange(ranges.start(0), cut)
        return
      }
      this.options.onError?.(error)
    })
  }

  private nextSegment(retain: number): LiveSegment | undefined {
    const t = this.options.currentTime()
    const from = Math.max(t - BEHIND_SEC, retain)
    return this.segments.find((s) => s.pts + s.dur > from && s.pts < t + AHEAD_SEC &&
      !this.appended.has(s.seq) && (this.failures.get(s.seq) ?? 0) < MAX_FAILURES)
  }

  private removeRange(start: number, end: number): void {
    if (end <= start) return
    for (const segment of this.segments) if (segment.pts + segment.dur <= end) this.appended.delete(segment.seq)
    this.busy = true
    this.options.sourceBuffer.remove(start, end)
  }
}
