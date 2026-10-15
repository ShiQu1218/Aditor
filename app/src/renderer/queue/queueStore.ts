import { EMPTY_SUMMARY, queueKey, summarizeQueue, type QueueItemState, type QueuePayload, type QueueSummary } from '../../shared/queueState'

/**
 * 全域分析佇列的單一資料來源（renderer）：環形進度、佇列條、浮層與每張卡片都從這裡讀，
 * 所以數字（進度、ETA、排隊與否）永遠一致。
 * 資料由 main 的 `library:updated` 事件（已 500 ms 節流）推入，這裡不呼叫 getEntries()。
 * 以 `useSyncExternalStore` 訂閱：卡片只訂閱自己的狀態（原始值），其他卡片不會因為進度更新而重繪。
 */
export interface QueueStore {
  set(payload: QueuePayload | null | undefined): void
  getSummary(): QueueSummary
  subscribe(listener: () => void): () => void
  /** 真實佇列狀態：analyzing／queued；其餘（匯入未排隊、取消後）為 idle */
  stateOf(path: string): QueueItemState
  /** 該影片的 ETA（毫秒）；非分析中或樣本不足為 null */
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
