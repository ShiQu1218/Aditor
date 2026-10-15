import type { AutoClipParams, CacheDoc, Clip } from '../shared/types'

/** 與 EngineClient.request 相容的最小介面（cmd／args → 結果）。 */
export type EngineRequest = (cmd: string, args: Record<string, unknown>) => Promise<unknown>

/**
 * 以預設參數惰性計算「N 精華」（spec §7.4）：只用**已存在的快取文件**呼叫 `autoclip`，
 * 絕不呼叫 engine `analyze`（快取不存在＝略過，hl 維持 undefined）。
 * 任何失敗回傳 null（不寫入），成功回傳 >= 0 的數字。
 */
export async function computeHlCount(
  request: EngineRequest,
  doc: CacheDoc | null,
  params: AutoClipParams
): Promise<number | null> {
  if (!doc || !Array.isArray(doc.events) || doc.analysis?.status !== 'done') return null
  try {
    const res = (await request('autoclip', {
      events: doc.events,
      params,
      duration: doc.video?.duration ?? 0
    })) as { clips?: unknown[] } | null
    return Array.isArray(res?.clips) ? res.clips.length : 0
  } catch {
    return null
  }
}

/**
 * 工作室儲存快取時由片段重算影片庫的 hl：文件已有 AI 片段＝目前待確認建議數；
 * 沒有 AI 片段（含重新分析後只剩手動片段）＝undefined，交給惰性計算重算。
 */
export function hlFromClips(clips: Clip[] | undefined): number | undefined {
  const ai = (clips ?? []).filter((c) => c.origin === 'ai')
  if (ai.length === 0) return undefined
  return ai.filter((c) => (c.status ?? 'accepted') === 'suggested').length
}

/** 並行度 1 的 FIFO；同一 key 在排隊或執行中時共用同一個 Promise（去重）。 */
export function createSerialQueue<T>(): {
  run: (key: string, task: () => Promise<T>) => Promise<T>
  size: () => number
} {
  const pending = new Map<string, Promise<T>>()
  let tail: Promise<unknown> = Promise.resolve()
  return {
    run(key, task) {
      const existing = pending.get(key)
      if (existing) return existing
      const p = tail.then(task)
      pending.set(key, p)
      const done = (): void => {
        pending.delete(key)
      }
      p.then(done, done)
      tail = p.catch(() => undefined)
      return p
    },
    size: () => pending.size
  }
}
