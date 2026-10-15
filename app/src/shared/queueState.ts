import { estimateEta } from './eta'

/** main 的 AnalysisQueue 真實狀態：正在分析的影片與排隊中的影片（依順序）。 */
export interface QueueSnapshot {
  analyzing: string | null
  queued: string[]
}

/** `library:updated` 事件與 `queue:getState` 的內容。 */
export interface QueuePayload {
  queue: QueueSnapshot
  /** 正在分析的項目進度；`analyzingSince` 為 main 記錄的分析開始時間（epoch ms） */
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
  /** 分析中在前，排隊依序在後 */
  rows: QueueRow[]
  analyzing: QueueRow | null
  /** 分析中＋排隊的總數（0＝佇列條隱藏） */
  total: number
  /** 目前分析進度 0–1（沒有分析中項目為 0） */
  progress: number
}

export const EMPTY_SUMMARY: QueueSummary = { rows: [], analyzing: null, total: 0, progress: 0 }

/** 路徑比對鍵（斜線與大小寫不敏感；shared 內不使用 Node path） */
export function queueKey(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0))

/**
 * 佇列摘要（純函式）：只依 main 提供的真實佇列狀態，不看 Library 的 `status === 'pending'`。
 * ETA ＝ `estimateEta(progress, now - analyzingSince)`（耗時 < 3 秒或進度 < 2% 為 null）。
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

/** 卡片狀態：analyzing／queued 取自真實佇列；其餘（含匯入未排隊、取消後）一律 idle＝「尚未分析」。 */
export function queueItemState(summary: QueueSummary, path: string): QueueItemState {
  const key = queueKey(path)
  const row = summary.rows.find((r) => queueKey(r.path) === key)
  return row ? row.state : 'idle'
}
