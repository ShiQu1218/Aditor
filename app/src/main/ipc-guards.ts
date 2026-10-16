import fs from 'fs'
import path from 'path'
import { cacheFilePath } from './cache-io'
import { isSafeLocalVideoPath } from './safe-path'

/**
 * IPC 的信任邊界（I1）：renderer 傳來的路徑一律不信任。
 * 專案檔的讀寫只允許「使用者剛在原生對話框選過」的路徑（一次性授權）。
 */
export type GrantKind = 'open' | 'save'

const normalizeGrantKey = (p: string): string => path.resolve(p).toLowerCase().replace(/\\/g, '/')

export function createPathGrants() {
  const granted: Record<GrantKind, Set<string>> = { open: new Set(), save: new Set() }
  return {
    grant(kind: GrantKind, p: string): void {
      granted[kind].add(normalizeGrantKey(p))
    },
    /** 命中即消耗（一次性）。 */
    consume(kind: GrantKind, p: unknown): boolean {
      if (typeof p !== 'string' || p.length === 0 || p.includes('\0')) return false
      return granted[kind].delete(normalizeGrantKey(p))
    }
  }
}
export type PathGrants = ReturnType<typeof createPathGrants>

const MAX_PROJECT_BYTES = 50 * 1024 * 1024

export function saveGrantedProject(g: PathGrants, filePath: unknown, content: unknown): boolean {
  if (typeof content !== 'string' || content.length > MAX_PROJECT_BYTES) return false
  if (typeof filePath !== 'string' || path.extname(filePath).toLowerCase() !== '.json') return false
  if (!g.consume('save', filePath)) return false
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, content, 'utf-8')
    return true
  } catch (err) {
    console.error('Failed to save project:', err)
    return false
  }
}

export function loadGrantedProject(g: PathGrants, filePath: unknown): string | null {
  if (typeof filePath !== 'string' || path.extname(filePath).toLowerCase() !== '.json') return null
  if (!g.consume('open', filePath)) return null
  try {
    const st = fs.statSync(filePath)
    if (!st.isFile() || st.size > MAX_PROJECT_BYTES) return null
    return fs.readFileSync(filePath, 'utf-8')
  } catch (err) {
    console.error('Failed to load project:', err)
    return null
  }
}

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
