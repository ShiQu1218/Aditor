import type { CacheDoc, VideoInfo } from '../../shared/types'

/**
 * Studio loading flow (pure logic with injected dependencies for testing):
 * 1. Check the library entry status first; reject anything other than 'done' without calling engine/cache IPC.
 * 2. Load the document with cache:load, which has no side effects.
 * 3. Call analyze only when the entry is done but has no cached document.
 * 4. Return an error for any failure; never return a fabricated default document.
 * Project switching may bypass the analysis restriction: if there is no cache, create a blank track from the actual video metadata without starting analysis.
 */
export interface LoaderDeps {
/** Library entry status; null when no entry is found. */
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
        const reason = !video ? 'the video file could not be probed (missing, unreadable, or unsupported)' : `probe returned duration ${video.duration}`
        return { kind: 'error', message: `Cannot open without analysis: ${reason}` }
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
    return { kind: 'error', message: `Analysis finished but its result is not usable (status: ${(res as CacheDoc | null)?.analysis?.status ?? 'none'})` }
  } catch (err) {
    return toError(err, `Loading failed: ${String(err)}`)
  }
}
