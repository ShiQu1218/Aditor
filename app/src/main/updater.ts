// 自動更新：用 electron-updater 檢查 GitHub Releases，背景下載，結束 Aditor 時安裝。
// 只有安裝版（NSIS）能更新；開發模式與免安裝版回報 unsupported，由設定頁引導到下載頁。
import type { UpdateStatus } from '../shared/update'

/** electron-updater 的 AppUpdater 用到的子集（測試可注入假的）。 */
export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: 'update-available' | 'update-downloaded', listener: (info: { version: string }) => void): unknown
  on(event: 'update-not-available', listener: () => void): unknown
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  checkForUpdates(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface UpdaterDeps {
  /** null＝不支援自動更新（開發模式、免安裝版） */
  updater: UpdaterLike | null
  /** 設定「自動檢查更新」是否開啟；手動檢查不受影響 */
  isEnabled: () => boolean
  /** 新版下載完成時通知一次 */
  notifyDownloaded: (version: string) => void
  /** 狀態改變時推給所有視窗 */
  broadcast: (status: UpdateStatus) => void
  initialDelayMs?: number
  intervalMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  setRepeat?: (fn: () => void, ms: number) => unknown
  clearTimers?: (handles: unknown[]) => void
}

export interface AppUpdaterService {
  status(): UpdateStatus
  /** 立即檢查（手動或排程）；回傳檢查後的狀態 */
  check(): Promise<UpdateStatus>
  /** 已下載時立即結束並安裝；回傳是否已開始安裝 */
  install(): boolean
  start(): void
  stop(): void
}

const HOUR = 60 * 60 * 1000
/** 啟動後等一下再檢查，不跟引擎、錄影器搶開機資源 */
export const UPDATE_INITIAL_DELAY_MS = 15_000
export const UPDATE_INTERVAL_MS = 6 * HOUR

/** 檢查中、下載中或已下載時，不再重複檢查 */
const BUSY = new Set<UpdateStatus['state']>(['checking', 'downloading', 'downloaded'])

export function createAppUpdater(deps: UpdaterDeps): AppUpdaterService {
  const { updater } = deps
  let current: UpdateStatus = { state: updater ? 'idle' : 'unsupported' }
  let notifiedVersion: string | null = null
  let handles: unknown[] = []

  const set = (next: UpdateStatus): void => {
    current = next
    deps.broadcast(next)
  }

  if (updater) {
    updater.autoDownload = true
    updater.autoInstallOnAppQuit = true
    updater.on('update-available', (info) => set({ state: 'downloading', version: info.version, percent: 0 }))
    updater.on('update-not-available', () => set({ state: 'latest' }))
    updater.on('download-progress', (p) => {
      if (current.state === 'downloading') set({ ...current, percent: Math.round(p.percent) })
    })
    updater.on('update-downloaded', (info) => {
      set({ state: 'downloaded', version: info.version })
      if (notifiedVersion === info.version) return
      notifiedVersion = info.version
      deps.notifyDownloaded(info.version)
    })
    updater.on('error', (error) => {
      // 已下載完成後的錯誤（例如之後的排程檢查失敗）不蓋掉「已下載」
      if (current.state !== 'downloaded') set({ state: 'error', error: error.message })
    })
  }

  const check = async (): Promise<UpdateStatus> => {
    if (!updater || BUSY.has(current.state)) return current
    set({ state: 'checking' })
    try {
      await updater.checkForUpdates()
    } catch (error) {
      if (current.state === 'checking') set({ state: 'error', error: error instanceof Error ? error.message : String(error) })
    }
    return current
  }

  const scheduled = (): void => {
    if (deps.isEnabled()) void check()
  }

  return {
    status: () => current,
    check,
    install: () => {
      if (!updater || current.state !== 'downloaded') return false
      updater.quitAndInstall(false, true)
      return true
    },
    start: () => {
      if (!updater || handles.length > 0) return
      const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
      const setRepeat = deps.setRepeat ?? ((fn, ms) => setInterval(fn, ms))
      handles = [
        setTimer(scheduled, deps.initialDelayMs ?? UPDATE_INITIAL_DELAY_MS),
        setRepeat(scheduled, deps.intervalMs ?? UPDATE_INTERVAL_MS)
      ]
    },
    stop: () => {
      const clear = deps.clearTimers ?? ((hs) => hs.forEach((h) => {
        clearTimeout(h as ReturnType<typeof setTimeout>)
        clearInterval(h as ReturnType<typeof setInterval>)
      }))
      clear(handles)
      handles = []
    }
  }
}

/** 是否能自動更新：只有打包後的安裝版；免安裝版由 electron-builder 設定 PORTABLE_EXECUTABLE_DIR。 */
export function canAutoUpdate(isPackaged: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return isPackaged && !env.PORTABLE_EXECUTABLE_DIR
}
