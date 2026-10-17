import { cacheFilePath } from './cache-io'
import { isSafeLocalVideoPath } from './safe-path'

function requireVideoPath(p: unknown): string {
  if (!isSafeLocalVideoPath(p)) throw new Error('影片路徑不正確')
  return p
}

/** `engine:probe`：只接受本機影片路徑（拒絕 http://、concat:、UNC）。 */
export function sanitizeProbeArgs(videoPath: unknown): { path: string } {
  return { path: requireVideoPath(videoPath) }
}

/** `engine:analyze`：renderer 只能指定影片（與是否強制重跑）；cache_dir／profile_dir／beside／hwaccel 由 main 決定。 */
export function sanitizeAnalyzeArgs(raw: unknown): { path: string; force?: boolean } {
  const r = (raw ?? {}) as Record<string, unknown>
  const out: { path: string; force?: boolean } = { path: requireVideoPath(r.path) }
  if (r.force === true) out.force = true
  return out
}

export function sanitizeDeriveArgs(raw: unknown): Record<string, unknown> {
  const r = (raw ?? {}) as Record<string, unknown>
  const out: Record<string, unknown> = { events: r.events, spectating: r.spectating }
  return out
}

export function sanitizeAutoclipArgs(raw: unknown): Record<string, unknown> {
  const r = (raw ?? {}) as Record<string, unknown>
  return { events: r.events, params: r.params, duration: r.duration }
}

/**
 * `cache:save`：忽略 renderer 的 `cache_path`，由影片路徑推得目的地；影片必須已在影片庫內。
 * 回傳 null＝拒絕。
 */
export function planCacheSave<D extends { cache_path?: string; video?: { path?: string } }>(
  doc: D | null | undefined,
  library: { get(p: string): unknown },
  cacheDir: string,
  beside: boolean
): { dest: string; doc: D & { cache_path: string } } | null {
  const videoPath = doc?.video?.path
  if (!doc || !isSafeLocalVideoPath(videoPath) || !library.get(videoPath)) return null
  const dest = cacheFilePath(videoPath, cacheDir, beside)
  return { dest, doc: { ...doc, cache_path: dest } }
}
