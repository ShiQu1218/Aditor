import fs from 'fs'
import path from 'path'
import type { Settings, SettingsSetResult } from '../shared/settings'
import { isSafeLocalDirPath } from './safe-path'
import type { SettingsStore } from './settings'
import { prepareStorageRoot, suggestStorageRoot } from './storage-root'

/** 取得「建議的儲存根資料夾」的 IPC 頻道（首次啟動引導與設定畫面用）。 */
export const STORAGE_SUGGEST_CHANNEL = 'settings:suggestStorageRoot'

export interface PasswordStorage {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

/** 所有設定 IPC 出口共用，密文也不跨越 renderer 邊界。 */
export function publicSettings(settings: Settings): Settings {
  if (!settings?.recording) return settings
  const { obsPasswordEnc, obsPassword: _password, ...recording } = settings.recording
  return { ...settings, recording: { ...recording, hasPassword: !!obsPasswordEnc } }
}

export function obsPassword(settings: Settings['recording'], storage: PasswordStorage): string | undefined {
  if (!settings.obsPasswordEnc) return undefined
  if (!storage.isEncryptionAvailable()) throw new Error('系統加密服務無法使用，無法讀取 OBS 密碼')
  try { return storage.decryptString(Buffer.from(settings.obsPasswordEnc, 'base64')) }
  catch { throw new Error('無法解密 OBS 密碼，請重新設定') }
}

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

/** 處理 partial 內的 storageRoot（就地改寫 partial；錯誤寫入 errors）。 */
function applyStorageRoot(partial: Partial<Settings>, errors: NonNullable<SettingsSetResult['errors']>): void {
  if (!('storageRoot' in partial) || partial.storageRoot === null) return
  try {
    const { root, recordingsDir, exportsDir } = prepareStorageRoot(partial.storageRoot)
    partial.storageRoot = root
    partial.defaultOutDir = exportsDir
    const recording = partial.recording && typeof partial.recording === 'object' ? partial.recording : {}
    partial.recording = { ...recording, outputDir: recordingsDir } as Settings['recording']
  } catch (err) {
    errors.storageRoot = (err as Error).message
    delete partial.storageRoot
  }
}

/**
 * `storageRoot`（字串）：建立 `<根>` 與子資料夾後，同步把 `recording.outputDir`、`defaultOutDir` 指到
 * `<根>/Recordings`、`<根>/Exports`；失敗時三個欄位都不套用並回報 `errors.storageRoot`。null 只清除 `storageRoot`。
 * `settings:get`／`settings:set`／`settings:changed`。
 * - `settings:set` 回傳 `{ settings, persisted, errors? }`（寫檔失敗以 `persisted:false` 回報，不丟錯）。
 * - `defaultOutDir` 在此驗證（絕對路徑／存在／資料夾），失敗時該欄位不套用並附 `errors.defaultOutDir`。
 * - `watchFolders` 只能經 `library:*WatchFolder`（WatchManager 驗證）修改，這裡一律忽略。
 */
export function registerSettingsHandlers(
  ipc: SettingsIpcLike,
  settings: SettingsStore,
  getWindows: () => WindowLike[],
  storage?: PasswordStorage,
  getVideosDir: () => string = () => ''
): void {
  settings.onChange((current) => {
    for (const win of getWindows()) {
      try {
        if (!win.isDestroyed()) win.webContents.send('settings:changed', publicSettings(current))
      } catch (err) {
        console.error('[Settings] failed to notify a window:', err)
      }
    }
  })

  ipc.handle('settings:get', () => publicSettings(settings.get()))

  ipc.handle(STORAGE_SUGGEST_CHANNEL, (): string => {
    const current = settings.get()
    return suggestStorageRoot({
      recordingOutputDir: current.recording.outputDir,
      defaultOutDir: current.defaultOutDir,
      videosDir: getVideosDir()
    })
  })

  ipc.handle('settings:set', (_event, raw: unknown): SettingsSetResult => {
    const partial: Partial<Settings> =
      typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? { ...(raw as Partial<Settings>) } : {}
    delete partial.watchFolders
    const errors: NonNullable<SettingsSetResult['errors']> = {}
    if (partial.recording && typeof partial.recording === 'object' && !Array.isArray(partial.recording)) {
      const recording = { ...partial.recording }
      delete recording.obsPasswordEnc
      delete recording.hasPassword
      const password = recording.obsPassword
      delete recording.obsPassword
      if (password !== undefined) {
        if (typeof password !== 'string' || password.length > 4096) errors.obsPassword = 'OBS 密碼格式無效或過長'
        else if (password === '') recording.obsPasswordEnc = null
        else if (!storage?.isEncryptionAvailable()) errors.obsPassword = '系統加密服務無法使用，無法儲存 OBS 密碼'
        else {
          try { recording.obsPasswordEnc = storage.encryptString(password).toString('base64') }
          catch { errors.obsPassword = 'OBS 密碼加密失敗，未儲存密碼' }
        }
      }
      partial.recording = recording
    }
    if ('defaultOutDir' in partial && partial.defaultOutDir !== null) {
      try {
        partial.defaultOutDir = validateOutDir(partial.defaultOutDir)
      } catch (err) {
        errors.defaultOutDir = (err as Error).message
        delete partial.defaultOutDir
      }
    }
    applyStorageRoot(partial, errors)
    const saved = settings.set(partial)
    const result = { ...saved, settings: publicSettings(saved.settings) }
    return Object.keys(errors).length > 0 ? { ...result, errors: { ...result.errors, ...errors } } : result
  })
}
