import { cacheFilePath } from './cache-io'
import { isSafeLocalVideoPath } from './safe-path'
import { tr } from '../shared/locale'

/** Throw unless the value is a safe local video path from the renderer. */
export function requireVideoPath(p: unknown): string {
  if (!isSafeLocalVideoPath(p)) throw new Error(tr('影片路徑不正確'))
  return p
}

/** `engine:probe`: accept only local video paths (reject http://, concat:, and UNC). */
export function sanitizeProbeArgs(videoPath: unknown): { path: string } {
  return { path: requireVideoPath(videoPath) }
}

/** `engine:analyze`: renderer may specify only the video (and whether to force a rerun); main determines cache_dir/profile_dir/beside/hwaccel. */
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
 * `library:remove` / `library:removeMany`: the renderer may only ask for the source file to be deleted.
 * Anything that is not a plain object with `deleteSource: true` keeps the files.
 */
export function sanitizeRemoveOptions(raw: unknown): { deleteSource: boolean } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { deleteSource: false }
  return { deleteSource: (raw as Record<string, unknown>).deleteSource === true }
}

/**
 * `cache:save`: ignore the renderer's `cache_path` and derive the destination from the video path; the video must already be in the library.
 * Return null to reject the request.
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
