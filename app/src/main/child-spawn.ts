import fs from 'fs'
import path from 'path'
import { tr } from '../shared/locale'

/** Leave PATH lookup to spawn; only absolute application binaries can be checked here. */
export function checkExecutable(command: string): void {
  if (path.isAbsolute(command) && !fs.statSync(command).isFile()) {
    throw Object.assign(new Error('Executable is not a file'), { code: 'ENOENT' })
  }
}

export function spawnFailure(error: unknown): { message: string; tags: Record<string, string> } {
  const code = (error as NodeJS.ErrnoException | null)?.code
  const errno = typeof code === 'string' && /^[A-Z0-9_]{1,16}$/.test(code) ? code : 'UNKNOWN'
  return {
    message: errno === 'ENOENT' || errno === 'ENOTDIR'
      ? tr('找不到或無法啟動必要程式。請重新安裝 Aditor，並檢查防毒軟體的隔離紀錄。')
      : tr('無法啟動必要程式（{code}）。請檢查檔案權限與防毒軟體設定。', { code: errno }),
    // Node's syscall may contain the full command path; only the fixed operation is safe to send.
    tags: { spawn_errno: errno, spawn_syscall: 'spawn' }
  }
}
