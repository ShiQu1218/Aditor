import { mergeOnReanalyze } from '../shared/clips'
import type { CacheDoc, Clip } from '../shared/types'
import { cacheFilePath, loadCacheDoc, saveCacheDoc } from './cache-io'

/** 分析開始前對既有快取的唯讀快照（只讀；絕不寫回）。 */
export interface PriorCache {
  clips: Clip[]
  /** 舊文件分析是否已完成（partial＝首次分析被中斷後接續，不算「重新分析」） */
  done: boolean
  /** 供判斷「引擎直接回傳快取（命中）」：video＋analysis 完全相同＝沒有重新分析 */
  fingerprint: string
}

const fingerprintOf = (doc: Partial<CacheDoc>): string => JSON.stringify([doc.video ?? null, doc.analysis ?? null])

/** 分析前呼叫：讀取既有快取（無副作用）。沒有快取／損毀＝null（首次分析）。 */
export function capturePriorCache(videoPath: string, cacheDir: string): PriorCache | null {
  const doc = loadCacheDoc(cacheFilePath(videoPath, cacheDir)) as Partial<CacheDoc> | null
  if (!doc || typeof doc !== 'object') return null
  return {
    clips: Array.isArray(doc.clips) ? doc.clips : [],
    done: doc.analysis?.status === 'done',
    fingerprint: fingerprintOf(doc)
  }
}

/**
 * 分析**成功**完成後呼叫。引擎的 `merge_clips` 只保留手動片段並覆寫快取，所以重新分析時
 * 由 main 補回：clips ＝ `mergeOnReanalyze(舊片段, [])`（手動保留；已加入的 AI 片段保留並標 stale；
 * 建議／略過丟棄），並設 `app.suggestionsPending = true`，工作室開啟時據此重算建議（只做一次）。
 *
 * 不處理的情況（回傳 false，快取維持引擎寫的樣子）：首次分析（沒有舊快取）、舊文件未完成、
 * 新結果未完成、引擎直接回傳快取（video／analysis 與分析前相同＝命中，不是重新分析）。
 * 取消／失敗不會呼叫本函式，所以舊快取不會被我們改寫。
 */
export function preserveClipsAfterReanalysis(
  prior: PriorCache | null,
  result: CacheDoc,
  videoPath: string,
  cacheDir: string
): boolean {
  if (!prior || !prior.done) return false
  if (!result || result.analysis?.status !== 'done') return false
  if (fingerprintOf(result) === prior.fingerprint) return false
  const doc: CacheDoc = {
    ...result,
    cache_path: result.cache_path || cacheFilePath(videoPath, cacheDir),
    clips: mergeOnReanalyze(prior.clips, []),
    app: { ...result.app, suggestionsPending: true }
  }
  return saveCacheDoc(doc)
}
