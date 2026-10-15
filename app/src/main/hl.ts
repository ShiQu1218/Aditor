import type { AutoClipParams, CacheDoc } from '../shared/types'

/** 與 EngineClient.request 相容的最小介面（cmd／args → 結果）。 */
export type EngineRequest = (cmd: string, args: Record<string, unknown>) => Promise<unknown>

export interface AnalyzeArgs {
  profile_dir: string
  cache_dir: string
}

/**
 * 以預設參數惰性計算「N 精華」（spec §7.4）：先經 engine `analyze`（命中快取）取得文件，
 * 再以 `autoclip` 計算片段數。任何失敗回傳 null（不寫入），成功回傳 >= 0 的數字。
 */
export async function computeHlCount(
  request: EngineRequest,
  videoPath: string,
  params: AutoClipParams,
  analyzeArgs: AnalyzeArgs
): Promise<number | null> {
  try {
    const doc = (await request('analyze', { path: videoPath, ...analyzeArgs })) as CacheDoc | null
    if (!doc || !Array.isArray(doc.events)) return null
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
