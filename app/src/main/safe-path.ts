import fs from 'fs'
import path from 'path'

/** 允許作為專案／影片庫來源的副檔名（小寫）。 */
export const ALLOWED_VIDEO_EXTS: ReadonlySet<string> = new Set(['.mp4', '.mkv', '.mov', '.webm', '.m4v', '.avi'])

/**
 * 專案檔（不受信任）裡的來源路徑是否可安全地在本機檢查：
 * 必須是字串、帶磁碟機代號的絕對路徑，不得為 UNC／網路／裝置路徑（`\\server`、`//`、`\\?\`、`\\.\`），
 * 且副檔名在白名單內。UNC 會觸發 SMB 連線（NTLM 外洩／卡住），一律不碰檔案系統。
 */
export function isSafeLocalVideoPath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096 || p.includes('\0')) return false
  if (p.startsWith('\\\\') || p.startsWith('//') || p.startsWith('\\/') || p.startsWith('/\\')) return false
  if (!/^[A-Za-z]:[\\/]/.test(p)) return false
  if (!path.win32.isAbsolute(p)) return false
  return ALLOWED_VIDEO_EXTS.has(path.win32.extname(p).toLowerCase())
}

type StatFn = (p: string) => Promise<{ isFile(): boolean }>

/** `library:fileExists` 的核心：不安全路徑直接 false（不碰檔案系統）；只有一般檔案才 true；絕不丟錯。 */
export async function fileExistsSafe(p: unknown, stat: StatFn = fs.promises.stat): Promise<boolean> {
  if (!isSafeLocalVideoPath(p)) return false
  try {
    return (await stat(p)).isFile()
  } catch {
    return false
  }
}

/**
 * 來自 renderer／設定檔（不受信任）的目錄路徑是否可安全使用：
 * 字串、無 NUL、長度合理、絕對路徑；Windows 上必須帶磁碟機代號且不得為 UNC／網路／裝置路徑。
 */
export function isSafeLocalDirPath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096 || p.includes('\0')) return false
  if (process.platform === 'win32') {
    if (p.startsWith('\\\\') || p.startsWith('//') || p.startsWith('\\/') || p.startsWith('/\\')) return false
    if (!/^[A-Za-z]:[\\/]/.test(p)) return false
  }
  return path.isAbsolute(p)
}
