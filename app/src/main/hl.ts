import { mergeOnReanalyze, suggestionCount } from '../shared/clips'
import type { AutoClipParams, CacheDoc, Clip } from '../shared/types'

/** 與 EngineClient.request 相容的最小介面（cmd／args → 結果）。 */
export type EngineRequest = (cmd: string, args: Record<string, unknown>) => Promise<unknown>

/**
 * 以預設參數惰性計算影片庫的「N 精華」＝**待確認建議數**（status === 'suggested'）。
 * - 只用**已存在的快取文件**；絕不呼叫 engine `analyze`（快取不存在／未完成＝null，hl 維持 undefined）。
 * - 文件已有 AI 片段：直接數 suggested（不呼叫引擎）。
 * - 文件沒有 AI 片段（只有手動片段）：autoclip 在預設參數下的片段數（工作室開啟時會放成建議）。
 * - 重新分析後 `app.suggestionsPending`：算出工作室將做的合併結果（mergeOnReanalyze）的建議數。
 * 任何失敗回傳 null（不寫入），成功回傳 >= 0 的數字。
 */
export async function computeHlCount(
  request: EngineRequest,
  doc: CacheDoc | null,
  params: AutoClipParams
): Promise<number | null> {
  if (!doc || !Array.isArray(doc.events) || doc.analysis?.status !== 'done') return null
  const clips = Array.isArray(doc.clips) ? doc.clips : []
  const pending = Boolean(doc.app?.suggestionsPending)
  if (!pending && clips.some((c) => c.origin === 'ai')) return hlFromClips(clips)
  try {
    const res = (await request('autoclip', {
      events: doc.events,
      params,
      duration: doc.video?.duration ?? 0
    })) as { clips?: Clip[] } | null
    const fresh = Array.isArray(res?.clips) ? res.clips : []
    return pending ? suggestionCount(mergeOnReanalyze(clips, fresh)) : fresh.length
  } catch {
    return null
  }
}

/** 由片段重算影片庫的 hl＝目前待確認建議數（舊檔缺 status 視為已加入）。 */
export function hlFromClips(clips: Clip[] | undefined): number {
  return (clips ?? []).filter((c) => c.origin === 'ai' && (c.status ?? 'accepted') === 'suggested').length
}

/** 工作室存檔時的 hl：重新分析的建議尚未重算（suggestionsPending）時不下結論（undefined＝交給惰性計算）。 */
export function hlForSavedDoc(doc: { clips?: Clip[]; app?: { suggestionsPending?: boolean } }): number | undefined {
  return doc.app?.suggestionsPending ? undefined : hlFromClips(doc.clips)
}

export const HL_NEGATIVE_TTL_MS = 60_000

/**
 * computeHl 的防護：
 * - 負快取：計算失敗（null）的影片 60 秒內不再重試（避免捲動時每張卡片反覆打引擎）。
 * - 修訂號：`bump` 代表有更新的權威 hl 寫入（工作室 cache:save）；較早開始的計算用
 *   `commitIfCurrent` 提交時若修訂號已變就放棄，舊結果不能蓋掉新的 hl。
 */
export function createHlGuard(now: () => number = Date.now) {
  const revs = new Map<string, number>()
  const failedAt = new Map<string, number>()
  return {
    rev: (key: string): number => revs.get(key) ?? 0,
    bump(key: string): void {
      revs.set(key, (revs.get(key) ?? 0) + 1)
      failedAt.delete(key)
    },
    isNegative(key: string): boolean {
      const at = failedAt.get(key)
      if (at === undefined) return false
      if (now() - at < HL_NEGATIVE_TTL_MS) return true
      failedAt.delete(key)
      return false
    },
    markFailed(key: string): void {
      failedAt.set(key, now())
    },
    commitIfCurrent(key: string, startedRev: number, write: () => void): boolean {
      if ((revs.get(key) ?? 0) !== startedRev) return false
      write()
      return true
    }
  }
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
