import type { CacheDoc, VideoInfo } from '../../shared/types'

/**
 * 工作室載入流程（純邏輯，依賴以參數注入，方便測試）：
 * 1. 先查影片庫條目狀態——不是 'done' 一律擋下，**不呼叫任何引擎／快取 IPC**；
 * 2. 以無副作用的 cache:load 取文件；
 * 3. 只有「條目 done 但沒有快取文件」才呼叫 analyze 補齊；
 * 4. 任何失敗＝錯誤結果，絕不回傳預設的假文件。
 * 專案切換可略過分析限制：沒有快取時以實際影片規格建立空白片軌，不另啟動分析。
 */
export interface LoaderDeps {
  /** 影片庫條目狀態；找不到條目回 null */
  getStatus: (path: string) => Promise<string | null>
  cacheLoad: (path: string) => Promise<CacheDoc | null>
  analyze: (args: { path: string }) => Promise<CacheDoc | null>
  probe?: (path: string) => Promise<VideoInfo | null>
}

export type LoadOutcome =
  | { kind: 'ready'; doc: CacheDoc; from: 'cache' | 'analyze' | 'metadata' }
  | { kind: 'blocked' }
  | { kind: 'error'; message: string; code?: string | number }

const isDone = (d: CacheDoc | null | undefined): d is CacheDoc => d?.analysis?.status === 'done'

function toError(err: unknown, fallback: string): LoadOutcome {
  const message = err instanceof Error ? err.message : fallback
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' || typeof code === 'number' ? { kind: 'error', message, code } : { kind: 'error', message }
}

export async function loadStudioDoc(path: string, deps: LoaderDeps, allowUnanalyzed = false): Promise<LoadOutcome> {
  try {
    const status = await deps.getStatus(path)
    if (status !== 'done' && !allowUnanalyzed) return { kind: 'blocked' }
    const cached = await deps.cacheLoad(path)
    if (allowUnanalyzed) {
      if (cached) return { kind: 'ready', doc: cached, from: 'cache' }
      const video = await deps.probe?.(path)
      if (!video || !Number.isFinite(video.duration) || video.duration <= 0) {
        return { kind: 'error', message: 'video duration unavailable' }
      }
      return {
        kind: 'ready', from: 'metadata',
        doc: {
          version: 1, video: { ...video, path },
          analysis: { status: 'partial', progress_t: 0, engine_version: '', templates_version: '', h_scale: 1 },
          events: [], spectating: [], clips: [], keyframes: [], cache_path: ''
        }
      }
    }
    if (cached) return isDone(cached) ? { kind: 'ready', doc: cached, from: 'cache' } : { kind: 'blocked' }
    const res = await deps.analyze({ path })
    if (isDone(res)) return { kind: 'ready', doc: res, from: 'analyze' }
    return { kind: 'error', message: 'analysis returned no usable result' }
  } catch (err) {
    return toError(err, 'load failed')
  }
}
