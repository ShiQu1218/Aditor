import fs from 'fs'
import path from 'path'

/** Allowed lowercase extensions for project/library video sources. */
export const ALLOWED_VIDEO_EXTS: ReadonlySet<string> = new Set(['.mp4', '.mkv', '.mov', '.webm', '.m4v', '.avi'])

/**
 * Whether a source path from an untrusted project file can be safely checked locally:
 * it must be a string, an absolute path with a drive letter, not a UNC/network/device path (`\\server`, `//`, `\\?\`, `\\.\`),
 * and have an allowlisted extension. UNC paths can trigger SMB connections (NTLM leakage or hangs), so never access them.
 */
export function isSafeLocalVideoPath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096 || p.includes('\0')) return false
  if (p.startsWith('\\\\') || p.startsWith('//') || p.startsWith('\\/') || p.startsWith('/\\')) return false
  if (!/^[A-Za-z]:[\\/]/.test(p)) return false
  if (!path.win32.isAbsolute(p)) return false
  return ALLOWED_VIDEO_EXTS.has(path.win32.extname(p).toLowerCase())
}

type StatFn = (p: string) => Promise<{ isFile(): boolean }>

/** Core of `library:fileExists`: return false for unsafe paths without touching the filesystem; true only for regular files; never throw. */
export async function fileExistsSafe(p: unknown, stat: StatFn = fs.promises.stat): Promise<boolean> {
  if (!isSafeLocalVideoPath(p)) return false
  try {
    return (await stat(p)).isFile()
  } catch {
    return false
  }
}

/**
 * Whether an untrusted directory path from the renderer/settings file is safe to use:
 * it must be a string, contain no NUL, have a reasonable length, and be absolute; on Windows it must include a drive letter and not be a UNC/network/device path.
 */
export function isSafeLocalDirPath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096 || p.includes('\0')) return false
  if (process.platform === 'win32') {
    if (p.startsWith('\\\\') || p.startsWith('//') || p.startsWith('\\/') || p.startsWith('/\\')) return false
    if (!/^[A-Za-z]:[\\/]/.test(p)) return false
  }
  return path.isAbsolute(p)
}
