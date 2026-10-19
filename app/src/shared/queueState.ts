import { estimateEta } from './eta'

/** Actual state from main AnalysisQueue: the video being analyzed and videos waiting in order. */
export interface QueueSnapshot {
  analyzing: string | null
  queued: string[]
}

/** Payload for the `library:updated` event and `queue:getState`. */
export interface QueuePayload {
  queue: QueueSnapshot
  /** Progress of the item being analyzed; `analyzingSince` is the analysis start time recorded by main (epoch ms). */
  current: { path: string; progress: number; analyzingSince: number | null } | null
}

export type QueueItemState = 'analyzing' | 'queued' | 'idle'

export interface QueueRow {
  path: string
  state: 'analyzing' | 'queued'
  progress: number
  etaMs: number | null
}

export interface QueueSummary {
  /** Item being analyzed first, followed by queued items in order. */
  rows: QueueRow[]
  analyzing: QueueRow | null
  /** Total number analyzing + queued (0 hides the queue bar). */
  total: number
  /** Current analysis progress 0–1 (0 when no item is being analyzed). */
  progress: number
}

export const EMPTY_SUMMARY: QueueSummary = { rows: [], analyzing: null, total: 0, progress: 0 }

/** Path comparison key (slashes and case-insensitive; do not use Node path in shared code). */
export function queueKey(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0))

/**
 * Queue summary (pure function): use only actual queue state from main, not Library `status === 'pending'`.
 * ETA = `estimateEta(progress, now - analyzingSince)` (null when elapsed < 3 seconds or progress < 2%).
 */
export function summarizeQueue(payload: QueuePayload | null | undefined, now: number): QueueSummary {
  if (!payload) return EMPTY_SUMMARY
  const { queue, current } = payload
  const rows: QueueRow[] = []
  let analyzing: QueueRow | null = null
  if (queue.analyzing) {
    const progress = clamp01(current && queueKey(current.path) === queueKey(queue.analyzing) ? current.progress : 0)
    const since = current?.analyzingSince
    analyzing = {
      path: queue.analyzing,
      state: 'analyzing',
      progress,
      etaMs: typeof since === 'number' ? estimateEta(progress, now - since) : null
    }
    rows.push(analyzing)
  }
  for (const p of queue.queued) {
    rows.push({ path: p, state: 'queued', progress: 0, etaMs: null })
  }
  return { rows, analyzing, total: rows.length, progress: analyzing?.progress ?? 0 }
}

/** Card state: analyzing/queued come from actual queue state; all others (including imported-but-not-queued/cancelled) are idle = "not yet analyzed." */
export function queueItemState(summary: QueueSummary, path: string): QueueItemState {
  const key = queueKey(path)
  const row = summary.rows.find((r) => queueKey(r.path) === key)
  return row ? row.state : 'idle'
}
