import { tr } from '../shared/locale'
import fs from 'fs'
import path from 'path'
import type { Settings, SettingsSetResult } from '../shared/settings'
import { isSafeLocalDirPath } from './safe-path'
import type { SettingsStore } from './settings'
import { prepareStorageRoot, suggestStorageRoot } from './storage-root'
import { RECORDINGS_DIRNAME } from '../shared/storage'

/** IPC channel for retrieving the suggested storage root (used by first-run setup and Settings). */
export const STORAGE_SUGGEST_CHANNEL = 'settings:suggestStorageRoot'

export interface PasswordStorage {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

/** Shared by all settings IPC endpoints; ciphertext does not cross the renderer boundary. */
export function publicSettings(settings: Settings): Settings {
  if (!settings?.recording) return settings
  const { obsPasswordEnc, obsPassword: _password, ...recording } = settings.recording
  return { ...settings, recording: { ...recording, hasPassword: !!obsPasswordEnc } }
}

export function obsPassword(settings: Settings['recording'], storage: PasswordStorage): string | undefined {
  if (!settings.obsPasswordEnc) return undefined
  if (!storage.isEncryptionAvailable()) throw new Error(tr('系統加密服務無法使用，無法讀取 OBS 密碼'))
  try { return storage.decryptString(Buffer.from(settings.obsPasswordEnc, 'base64')) }
  catch { throw new Error(tr('無法解密 OBS 密碼，請重新設定')) }
}

/** Minimal ipcMain subset (for dependency injection in tests). */
export interface SettingsIpcLike {
  handle(channel: string, fn: (event: any, ...args: any[]) => unknown): void
}

export interface WindowLike {
  isDestroyed(): boolean
  webContents: { send(channel: string, data: unknown): void }
}

/**
 * Validate a folder path written through Settings: it must be a local absolute path to an existing directory.
 * Return the `path.resolve` result when valid; otherwise throw an error that can be displayed directly in the Settings row.
 * (SettingsStore validates types only; checking path existence belongs to the main UI entry point.)
 */
export function validateOutDir(dir: unknown): string {
  if (!isSafeLocalDirPath(dir)) {
    throw new Error(tr('資料夾必須是本機絕對路徑：{path}', { path: typeof dir === 'string' ? dir : String(dir) }))
  }
  const resolved = path.resolve(dir)
  let stat: fs.Stats
  try {
    stat = fs.statSync(resolved)
  } catch {
    throw new Error(tr('資料夾不存在：{path}', { path: resolved }))
  }
  if (!stat.isDirectory()) {
    throw new Error(tr('路徑不是資料夾：{path}', { path: resolved }))
  }
  return resolved
}

/** Whether a recording folder still holds session work that startup recovery finds only while it is the output folder. */
function hasUnfinishedSessions(outputDir: string): boolean {
  try {
    return fs.readdirSync(path.join(outputDir, '.sessions'), { withFileTypes: true }).some((entry) => entry.isDirectory())
  } catch {
    return false
  }
}

const samePath = (a: string, b: string): boolean =>
  process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b)

/** Handle storageRoot in a partial settings object (mutate partial in place; add failures to errors). */
function applyStorageRoot(partial: Partial<Settings>, errors: NonNullable<SettingsSetResult['errors']>, currentOutputDir: string | null): void {
  if (!('storageRoot' in partial) || partial.storageRoot === null) return
  if (currentOutputDir && typeof partial.storageRoot === 'string' && isSafeLocalDirPath(partial.storageRoot) &&
      !samePath(path.join(partial.storageRoot, RECORDINGS_DIRNAME), currentOutputDir) && hasUnfinishedSessions(currentOutputDir)) {
    errors.storageRoot = tr('目前的錄影資料夾還有尚未完成收尾的錄影，請先完成或恢復錄影後再變更儲存位置：{path}', { path: currentOutputDir })
    delete partial.storageRoot
    if (partial.recording && typeof partial.recording === 'object') {
      const { outputDir: _keep, ...recording } = partial.recording
      partial.recording = recording as Settings['recording']
    }
    return
  }
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
 * `storageRoot` (string): create `<root>` and its subdirectories, then set `recording.outputDir` and `defaultOutDir` to
 * `<root>/Recordings` and `<root>/Exports`; on failure, apply none of the three fields and return `errors.storageRoot`. null clears only `storageRoot`.
 * `settings:get`／`settings:set`／`settings:changed`。
 * - `settings:set` returns `{ settings, persisted, errors? }` (reports write failures as `persisted:false` instead of throwing).
 * - Validate `defaultOutDir` here (absolute path/existing/directory); on failure, do not apply the field and add `errors.defaultOutDir`.
 * - Modify `watchFolders` only through `library:*WatchFolder` (validated by WatchManager); always ignore it here.
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
        if (typeof password !== 'string' || password.length > 4096) errors.obsPassword = tr('OBS 密碼格式無效或過長')
        else if (password === '') recording.obsPasswordEnc = null
        else if (!storage?.isEncryptionAvailable()) errors.obsPassword = tr('系統加密服務無法使用，無法儲存 OBS 密碼')
        else {
          try { recording.obsPasswordEnc = storage.encryptString(password).toString('base64') }
          catch { errors.obsPassword = tr('OBS 密碼加密失敗，未儲存密碼') }
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
    applyStorageRoot(partial, errors, settings.get().recording.outputDir)
    const saved = settings.set(partial)
    const result = { ...saved, settings: publicSettings(saved.settings) }
    return Object.keys(errors).length > 0 ? { ...result, errors: { ...result.errors, ...errors } } : result
  })
}
