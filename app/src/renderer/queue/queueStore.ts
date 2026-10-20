import { EMPTY_SUMMARY, queueKey, summarizeQueue, type QueueItemState, type QueuePayload, type QueueSummary } from '../../shared/queueState'

/**
 * Single renderer-side source of truth for the global analysis queue: the progress ring, queue strip, popover, and each card read from here,
 * keeping progress, ETA, and queue state consistent.
 * Main sends updates through throttled `library:updated` events (500 ms); this store does not call getEntries().
 * Subscribe with `useSyncExternalStore`: each card subscribes only to its own primitive state, so other cards do not rerender on progress updates.
 */
export interface QueueStore {
  set(payload: QueuePayload | null | undefined): void
  getSummary(): QueueSummary
  subscribe(listener: () => void): () => void
  /** Actual queue state: analyzing/queued; all other cases (imported but not queued, canceled) are idle. */
  stateOf(path: string): QueueItemState
  /** ETA for this video in milliseconds; null when not analyzing or when there are too few samples. */
  etaOf(path: string): number | null
}

export function createQueueStore(clock: () => number = Date.now): QueueStore {
  let summary: QueueSummary = EMPTY_SUMMARY
  let byKey = new Map<string, QueueSummary['rows'][number]>()
  const listeners = new Set<() => void>()

  return {
    set(payload) {
      const valid = payload && payload.queue && Array.isArray(payload.queue.queued) ? payload : null
      summary = valid ? summarizeQueue(valid, clock()) : EMPTY_SUMMARY
      byKey = new Map(summary.rows.map((r) => [queueKey(r.path), r]))
      for (const fn of [...listeners]) fn()
    },
    getSummary: () => summary,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    stateOf: (path) => byKey.get(queueKey(path))?.state ?? 'idle',
    etaOf: (path) => byKey.get(queueKey(path))?.etaMs ?? null
  }
}
