// Auto-update: use electron-updater to check GitHub Releases, download in the background, and install when Aditor exits.
// Only installed (NSIS) builds support updates; development and portable builds report unsupported, and Settings links to the download page.
import type { UpdateStatus } from '../shared/update'

/** Native import() exposes electron-updater's CommonJS singleton through default. */
export async function loadAutoUpdater(): Promise<UpdaterLike> {
  const { default: electronUpdater } = await import('electron-updater')
  return electronUpdater.autoUpdater
}

/** Subset of electron-updater AppUpdater used here (tests can inject a fake). */
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
  /** null = auto-update is unsupported (development or portable build). */
  updater: UpdaterLike | null
  /** Whether automatic update checks are enabled; manual checks are unaffected. */
  isEnabled: () => boolean
  /** Notify once when a new version finishes downloading. */
  notifyDownloaded: (version: string) => void
  /** Broadcast status changes to all windows. */
  broadcast: (status: UpdateStatus) => void
  /**
   * Quit through the normal shutdown path (app.quit), which runs the quit guard. Manual installs start the
   * installer only after that guard has finished recording finalization, library flush and bounded cleanup.
   */
  requestQuit: () => void
  initialDelayMs?: number
  intervalMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  setRepeat?: (fn: () => void, ms: number) => unknown
  clearTimers?: (handles: unknown[]) => void
}

export interface AppUpdaterService {
  status(): UpdateStatus
  /** Check immediately (manual or scheduled); return the resulting status. */
  check(): Promise<UpdateStatus>
  /** Request an immediate install and quit gracefully; the installer starts after the quit guard finishes finalization. */
  install(): boolean
  /** Called by the quit guard after finalization; start a requested install once and report whether it did. */
  installIfRequested(): boolean
  start(): void
  stop(): void
}

const HOUR = 60 * 60 * 1000
/** Wait briefly after startup before checking, so the updater does not compete with the engine and recorder during launch. */
export const UPDATE_INITIAL_DELAY_MS = 15_000
export const UPDATE_INTERVAL_MS = 6 * HOUR

/** Do not start another check while one is checking, downloading, or already downloaded. */
const BUSY = new Set<UpdateStatus['state']>(['checking', 'downloading', 'downloaded'])

export function createAppUpdater(deps: UpdaterDeps): AppUpdaterService {
  const { updater } = deps
  let current: UpdateStatus = { state: updater ? 'idle' : 'unsupported' }
  let notifiedVersion: string | null = null
  let handles: unknown[] = []
  /** A manual install is requested while the app is still finalizing recording work; start the installer only once. */
  let installRequested = false
  let installerStarted = false
  /** Set when electron-updater reports a synchronous installer-start failure from quitAndInstall(). */
  let installerFailed = false

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
      // electron-updater reports an installer that cannot start synchronously from quitAndInstall(). Remember it so the
      // quit guard can fall back to app.quit() instead of leaving Aditor stuck after before-quit was already prevented.
      if (installRequested && installerStarted) installerFailed = true
      // Errors after download completion (for example, a later scheduled check failure) must not overwrite the "downloaded" state.
      // Once the user has requested installation, an installer-start failure must be visible in the UI instead.
      if (current.state !== 'downloaded' || installRequested) set({ state: 'error', error: error.message })
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
      if (!updater || current.state !== 'downloaded' || installRequested) return false
      installRequested = true
      // Do not call quitAndInstall here: electron-updater spawns the NSIS installer synchronously, which can terminate
      // Aditor while recording finalization/remux is still running. The quit guard calls installIfRequested afterwards.
      deps.requestQuit()
      return true
    },
    installIfRequested: () => {
      if (!updater || !installRequested || installerStarted) return false
      // Mark before the call so a synchronous throw or a repeated quit cannot spawn a second installer.
      installerStarted = true
      try {
        // Keep the original manual-install behavior: visible installer, then relaunch after updating.
        updater.quitAndInstall(false, true)
        // electron-updater dispatches 'error' synchronously and skips app.quit() when no installer can start. Report
        // failure to the quit guard so it falls back to a normal quit instead of leaving the app half-quitting.
        return !installerFailed
      } catch (error) {
        set({ state: 'error', error: error instanceof Error ? error.message : String(error) })
        return false
      }
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

/** Auto-update is available only in an installed packaged build; electron-builder sets PORTABLE_EXECUTABLE_DIR for portable builds. */
export function canAutoUpdate(isPackaged: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return isPackaged && !env.PORTABLE_EXECUTABLE_DIR
}
