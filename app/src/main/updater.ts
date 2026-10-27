// Auto-update: use electron-updater to check GitHub Releases. Automatic checks (when enabled) only discover a version;
// downloading and installing are separate explicit user actions in Settings.
// Only installed (NSIS) builds support updates; development and portable builds report unsupported, and Settings links to the download page.
import type { UpdateStatus } from '../shared/update'

/** Native import() exposes electron-updater's CommonJS singleton through default. */
export async function loadAutoUpdater(): Promise<UpdaterLike> {
  const { default: electronUpdater } = await import('electron-updater')
  // Console logging can emit EPIPE when its output pipe closes; update errors already reach our status listener.
  electronUpdater.autoUpdater.logger = null
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
  /** Explicit download of the version discovered by checkForUpdates(); requires autoDownload = false. */
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface UpdaterDeps {
  /** null = auto-update is unsupported (development or portable build). */
  updater: UpdaterLike | null
  /** Whether automatic update checks are enabled; manual checks are unaffected. */
  isEnabled: () => boolean
  /** Notify once when a new version is discovered; the user still has to download it explicitly. */
  notifyAvailable: (version: string) => void
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
  /** Check immediately (manual or scheduled); only discovers versions and never starts a download. */
  check(): Promise<UpdateStatus>
  /** Explicit user action: download the available version. Repeated clicks while downloading are ignored. */
  download(): boolean
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

/** Do not start another check while one is checking, waiting for an explicit download, downloading, or already downloaded. */
const BUSY = new Set<UpdateStatus['state']>(['checking', 'available', 'downloading', 'downloaded'])

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function createAppUpdater(deps: UpdaterDeps): AppUpdaterService {
  const { updater } = deps
  let current: UpdateStatus = { state: updater ? 'idle' : 'unsupported' }
  let notifiedVersion: string | null = null
  let handles: unknown[] = []
  /** Prevents a double click or an IPC retry from starting a second electron-updater download. */
  let downloadRequested = false
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
    // Discovery only. A scheduled check must never download or install anything; both require an explicit click in Settings.
    updater.autoDownload = false
    // Never let an ordinary quit install a downloaded update. Only the explicit install action may start the installer,
    // after the quit guard has finalized recording work.
    updater.autoInstallOnAppQuit = false
    updater.on('update-available', (info) => {
      // A download already in progress or a completed download is newer information than a repeated availability event.
      if (current.state === 'downloading' || current.state === 'downloaded') return
      set({ state: 'available', version: info.version })
      if (notifiedVersion === info.version) return
      notifiedVersion = info.version
      deps.notifyAvailable(info.version)
    })
    updater.on('update-not-available', () => {
      // Do not discard an already available/downloaded version because of an unrelated check result.
      if (current.state === 'available' || current.state === 'downloading' || current.state === 'downloaded') return
      set({ state: 'latest' })
    })
    updater.on('download-progress', (p) => {
      if (current.state === 'downloading') set({ ...current, percent: Math.round(p.percent) })
    })
    updater.on('update-downloaded', (info) => {
      downloadRequested = false
      set({ state: 'downloaded', version: info.version })
    })
    updater.on('error', (error) => {
      // electron-updater reports an installer that cannot start synchronously from quitAndInstall(). Remember it so the
      // quit guard can fall back to app.quit() instead of leaving Aditor stuck after before-quit was already prevented.
      if (installRequested && installerStarted) installerFailed = true
      if (current.state === 'downloading') downloadRequested = false
      // Errors after download completion (for example, a later check failure) must not overwrite the "downloaded" state.
      // Once the user has requested installation, an installer-start failure must be visible in the UI instead.
      if (current.state !== 'downloaded' || installRequested) set({ state: 'error', error: error.message })
    })
  }

  const check = async (): Promise<UpdateStatus> => {
    if (!updater || BUSY.has(current.state)) return current
    set({ state: 'checking' })
    try {
      // electron-updater emits update-available; discovery never downloads because autoDownload is false.
      await updater.checkForUpdates()
    } catch (error) {
      if (current.state === 'checking') set({ state: 'error', error: errorMessage(error) })
    }
    return current
  }

  const scheduled = (): void => {
    // Automatic checks are controlled by the setting; the manual check action is always allowed.
    if (deps.isEnabled()) void check()
  }

  return {
    status: () => current,
    check,
    download: () => {
      if (!updater || current.state !== 'available' || downloadRequested) return false
      // Mark synchronously before calling electron-updater so a second click cannot start another download.
      downloadRequested = true
      set({ state: 'downloading', version: current.version, percent: 0 })
      try {
        void Promise.resolve(updater.downloadUpdate()).catch((error) => {
          // Ignore a late rejection after the download completed or after a retry started.
          if (current.state !== 'downloading') return
          downloadRequested = false
          set({ state: 'error', error: errorMessage(error) })
        })
      } catch (error) {
        downloadRequested = false
        set({ state: 'error', error: errorMessage(error) })
        return false
      }
      return true
    },
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
        set({ state: 'error', error: errorMessage(error) })
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
