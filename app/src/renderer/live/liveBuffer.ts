/**
 * MSE segment queue for watching an active recording (DOM-independent; testable with a mock SourceBuffer).
 *
 * - Append init.mp4 first, then append unbuffered segments near the playhead (BEHIND seconds behind / AHEAD seconds ahead) in time order;
 *   perform one operation at a time and wait for `updateend` before the next. Use `mode = 'segments'` to place segments by their timestamps.
 * - Retain only the latest RETAIN_SEC (30 minutes): release older buffered data with `remove()`; if the browser reports a quota error,
 *   first remove data before the playhead and retry during the next cycle.
 * - Do not load the entire recording at once: 30 minutes of high-bitrate footage exceeds MSE quota by far. Load only near the playhead, fetching more on seek/drag.
 */
import type { LiveSegment } from '../../shared/recording'

export const RETAIN_SEC = 30 * 60
export const AHEAD_SEC = 8
export const BEHIND_SEC = 2
/** When jumping to live, stop a few seconds before the newest segment ends to give the decoder some buffer. */
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
/** Call while buffering is idle so MediaSource.duration grows with the recording. */
  setDuration?: (seconds: number) => void
  onError?: (error: unknown) => void
  onBuffered?: () => void
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
    this.options.onBuffered?.()
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

/** Current end of the recording, in seconds. */
  liveEnd(): number {
    const last = this.segments[this.segments.length - 1]
    return last ? last.pts + last.dur : 0
  }

/** Start of the retained range; earlier content has been released (watch it in the studio after recording ends). */
  retainStart(): number { return Math.max(0, this.liveEnd() - RETAIN_SEC) }

/** Call after seeking/pausing: the browser may have evicted buffered data, so recheck which segments need fetching. */
  revalidate(): void {
    const ranges = this.options.sourceBuffer.buffered
    const t = this.options.currentTime()
    for (const segment of this.segments) {
      const from = Math.max(segment.pts, this.retainStart(), t - BEHIND_SEC)
      const to = Math.min(segment.pts + segment.dur, t + AHEAD_SEC)
      if (this.appended.has(segment.seq) && to > from &&
          (!covers(ranges, (from + to) / 2) || (t >= from && t < to && !covers(ranges, t)))) this.appended.delete(segment.seq)
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
      this.failures.delete(segment.seq)
    }).catch((error) => {
      if (this.disposed) return
      this.busy = false
      if (!this.segments.some(s => s.seq === segment.seq)) { this.pump(); return }
      this.failures.set(segment.seq, (this.failures.get(segment.seq) ?? 0) + 1)
      if ((error as DOMException)?.name === 'QuotaExceededError') {
        // Evict outside the playback window, including future data retained after a backward seek.
        const ranges = this.options.sourceBuffer.buffered
        const cut = this.options.currentTime() - BEHIND_SEC
        if ((this.failures.get(segment.seq) ?? 0) < MAX_FAILURES && ranges.length > 0) {
          if (ranges.start(0) < cut) { this.removeRange(ranges.start(0), cut); return }
          const ahead = this.options.currentTime() + AHEAD_SEC
          const end = ranges.end(ranges.length - 1)
          if (end > ahead) { this.removeRange(ahead, end); return }
        }
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
    for (const segment of this.segments) {
      if (segment.pts >= start && segment.pts + segment.dur <= end) this.appended.delete(segment.seq)
    }
    this.busy = true
    this.options.sourceBuffer.remove(start, end)
  }
}
