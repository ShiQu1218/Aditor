import fs from 'fs'
import path from 'path'
import type { Settings, SettingsSetResult } from '../shared/settings'
import { isSafeLocalDirPath } from './safe-path'
import type { SettingsStore } from './settings'

/** ipcMain 的最小子集（方便測試注入）。 */
export interface SettingsIpcLike {
  handle(channel: string, fn: (event: any, ...args: any[]) => unknown): void
}

export interface WindowLike {
  isDestroyed(): boolean
  webContents: { send(channel: string, data: unknown): void }
}

/**
 * 經由設定畫面寫入的資料夾路徑驗證：必須是本機絕對路徑、存在、且為資料夾。
 * 通過時回傳 `path.resolve` 後的路徑；否則丟出訊息可直接顯示在設定列的錯誤。
 * （SettingsStore 只做型別驗證；路徑是否存在屬於 main 的 UI 入口職責。）
 */
export function validateOutDir(dir: unknown): string {
  if (!isSafeLocalDirPath(dir)) {
    throw new Error(`資料夾必須是本機絕對路徑：${typeof dir === 'string' ? dir : String(dir)}`)
  }
  const resolved = path.resolve(dir)
  let stat: fs.Stats
  try {
    stat = fs.statSync(resolved)
  } catch {
    throw new Error(`資料夾不存在：${resolved}`)
  }
  if (!stat.isDirectory()) {
    throw new Error(`路徑不是資料夾：${resolved}`)
  }
  return resolved
}

/**
 * `settings:get`／`settings:set`／`settings:changed`。
 * - `settings:set` 回傳 `{ settings, persisted, errors? }`（寫檔失敗以 `persisted:false` 回報，不丟錯）。
 * - `defaultOutDir` 在此驗證（絕對路徑／存在／資料夾），失敗時該欄位不套用並附 `errors.defaultOutDir`。
 * - `watchFolders` 只能經 `library:*WatchFolder`（WatchManager 驗證）修改，這裡一律忽略。
 */
export function registerSettingsHandlers(
  ipc: SettingsIpcLike,
  settings: SettingsStore,
  getWindows: () => WindowLike[]
): void {
  settings.onChange((current) => {
    for (const win of getWindows()) {
      try {
        if (!win.isDestroyed()) win.webContents.send('settings:changed', current)
      } catch (err) {
        console.error('[Settings] failed to notify a window:', err)
      }
    }
  })

  ipc.handle('settings:get', () => settings.get())

  ipc.handle('settings:set', (_event, raw: unknown): SettingsSetResult => {
    const partial: Partial<Settings> =
      typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? { ...(raw as Partial<Settings>) } : {}
    delete partial.watchFolders
    const errors: NonNullable<SettingsSetResult['errors']> = {}
    if ('defaultOutDir' in partial && partial.defaultOutDir !== null) {
      try {
        partial.defaultOutDir = validateOutDir(partial.defaultOutDir)
      } catch (err) {
        errors.defaultOutDir = (err as Error).message
        delete partial.defaultOutDir
      }
    }
    const result = settings.set(partial)
    return Object.keys(errors).length > 0 ? { ...result, errors } : result
  })
}
