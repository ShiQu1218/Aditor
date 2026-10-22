import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron'
import { createAppQuitGuard } from './quit-guard'
import { delimiter, join, resolve } from 'path'
import { EngineClient } from './engine'
import { Library } from './library'
import { AnalysisQueue } from './queue'
import { SettingsStore, loadSettings } from './settings'
import { initializeTelemetry, updateTelemetryConsent, reportChildDiagnostic } from './telemetry'
import { WatchManager } from './watch'
import { ProjectStore } from './projects'
import { registerIpcHandlers } from './ipc-handlers'
import { createCloseGate } from './project-ipc'
import { buildAnalyzeArgs } from './settings-derived'
import { currentE2EConfig } from './e2e'
import { applyWindowSecurity } from './window-security'
import { sanitizeAnalyzeArgs, sanitizeAutoclipArgs, sanitizeDeriveArgs, sanitizeProbeArgs } from './ipc-guards'
import { aditorrecCommand, appDataDir, cacheDir, chromiumUserDataDir, engineCommand, ffmpegExecutable, liveEngineCommand, profileDir, sceneDir } from '../shared/paths'
import { cacheFilePath } from './cache-io'
import { generateThumbnail } from './thumbnail'
import { createRecordingService } from './recording'
import { registerRecordingIpc } from './recording-ipc'
import { createRecordingTray } from './tray'
import { resolveLocale, setActiveLocale, tr, type Locale } from '../shared/locale'
import { createRecordingNotifier } from './notify'
import type { RecordingService } from '../shared/recording'
import { obsPassword } from './settings-ipc'
import { createDiagnosticLog } from './recording/diagnostic-log'
import { canAutoUpdate, createAppUpdater, loadAutoUpdater, type AppUpdaterService } from './updater'
import { broadcastUpdateStatus, registerUpdateIpc } from './update-ipc'

// E2E hooks (ADITOR_E2E=1 only): use temporary appData/userData so tests do not touch user data; null in production.
const e2e = currentE2EConfig()
if (e2e?.appData) process.env.APPDATA = e2e.appData
// Must be set before ready: the default userData Cache and analysis cache use the same directory (see chromiumUserDataDir).
app.setPath('userData', chromiumUserDataDir())

let mainWindow: BrowserWindow | null = null
let engineClient: EngineClient | null = null
let library: Library | null = null
let queue: AnalysisQueue | null = null
let settingsStore: SettingsStore | null = null
let watchManager: WatchManager | null = null
let closeGate: ReturnType<typeof createCloseGate> | null = null
let cancelExport: (() => Promise<void>) | null = null
let recordingService: RecordingService | null = null
let tray: ReturnType<typeof createRecordingTray> | null = null
let unregisterRecordingIpc: (() => void) | null = null
let unsubscribeSettings: (() => void) | null = null
let appUpdater: AppUpdaterService | null = null
let quitting = false
/** Currently active interface language (from the `language` setting; `auto` follows the Windows display language). */
let locale: Locale = 'zh-TW'
let servicesReady = false
let openRequested = !process.argv.includes('--hidden')
/** Maximum time to wait before closing the window when the renderer does not respond to flush. */
const CLOSE_FLUSH_TIMEOUT_MS = 1500

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    icon: join(app.isPackaged ? process.resourcesPath : resolve(__dirname, '../..'), 'resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // preload uses only contextBridge/ipcRenderer and can run in the sandbox (I2).
      sandbox: true,
      contextIsolation: true
    }
  })

  applyWindowSecurity(mainWindow.webContents)

  // Ask the renderer to immediately save the latest project before closing (a second safeguard beyond beforeunload's sendSync).
  // Close only after receiving flushDone or timing out.
  const win = mainWindow
  const rendererAlive = (): boolean => !win.isDestroyed() && !win.webContents.isDestroyed() && !win.webContents.isCrashed()
  const shouldHide = (): boolean => !quitting && tray !== null && settingsStore?.get().recording.closeToTray === true
  const makeCloseGate = (): ReturnType<typeof createCloseGate> => createCloseGate({
    request: () => win.webContents.send('projects:flushRequest'),
    close: () => {
      if (shouldHide()) {
        win.hide()
        // Recreate the handshake each time the app is minimized to the tray so the latest project is saved on the next close.
        closeGate = makeCloseGate()
      } else win.close()
    },
    timeoutMs: CLOSE_FLUSH_TIMEOUT_MS,
    rendererAlive,
    isQuitting: () => quitting,
    quit: () => app.quit()
  })
  closeGate = makeCloseGate()
  win.on('close', (e) => {
    if (shouldHide() && !rendererAlive()) {
      e.preventDefault()
      win.hide()
      return
    }
    closeGate?.onClose(e)
  })
  // Ask the renderer to pause playback when minimized to the tray or taskbar so audio does not continue in the background.
  const pausePlayback = (): void => {
    if (rendererAlive()) win.webContents.send('app:windowHidden')
  }
  win.on('hide', pausePlayback)
  win.on('minimize', pausePlayback)
  win.on('closed', () => {
    closeGate = null
    mainWindow = null
    // Cancel exports when the window closes so ffmpeg is not orphaned (webContents 'destroyed' triggers the same cancellation).
    void cancelExport?.()
  })

  win.on('ready-to-show', () => {
    win.show()
    win.focus()
  })

  loadRenderer(mainWindow)
}

/** Read the language from the URL's `lang` when the renderer starts; reload with the new language after a change (beforeunload saves unsaved projects first). */
function loadRenderer(win: BrowserWindow): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    url.searchParams.set('lang', locale)
    void win.loadURL(url.toString())
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query: { lang: locale } })
  }
}

/** Resolve the interface language again from settings; return whether it changed. */
function syncLocale(): boolean {
  const next = resolveLocale(settingsStore?.get().language, app.getLocale())
  if (next === locale) return false
  locale = next
  setActiveLocale(next)
  return true
}

function showMainWindow(): void {
  openRequested = true
  if (!servicesReady || quitting) return
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  else {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
}

async function initEngineAndServices(): Promise<void> {
  if (app.isPackaged) {
    const ffmpegPath = ffmpegExecutable(true)
    process.env.ADITOR_FFMPEG = ffmpegPath
    const binDir = resolve(join(ffmpegPath, '..'))
    process.env.PATH = `${binDir}${delimiter}${process.env.PATH || ''}`
  }

  const cmd = e2e?.fakeEngine ?? engineCommand(app.isPackaged)
  engineClient = new EngineClient({ ...cmd, onDiagnostic: reportChildDiagnostic })
  try {
    const res = await engineClient.start()
    console.log(`[Engine] Ready, version: ${res.engineVersion}`)
  } catch (err) {
    console.error('[Engine] Failed to start engine:', err)
  }

  // Leftover partial proxy files from the previous interrupted run.
  ;(await import('./proxy')).cleanStaleProxyPartials()

  const templateProfileDir = profileDir(app.isPackaged)

  library = new Library(join(appDataDir(), 'library.json'))
  // Reset leftover "analyzing" entries from the previous interrupted run; no queue is processing them.
  library.resetStaleAnalyzing()
  settingsStore = new SettingsStore(join(appDataDir(), 'settings.json'))
  settingsStore.onChange((settings) => updateTelemetryConsent(settings.telemetryEnabled))
  syncLocale()
  queue = new AnalysisQueue(engineClient, library, {
    profileDir: templateProfileDir,
    cacheDir: cacheDir(),
    // Read decode/cacheLocation for each analysis so setting changes take effect without a restart.
    getSettings: () => settingsStore?.get()
  })

  // Restore folder watching from settings; automatically import new videos (enqueue them when autoAnalyze is enabled).
  watchManager = new WatchManager({ library, queue, settings: settingsStore })
  watchManager.start()

  // Project autosave: `%APPDATA%\Aditor\projects\<id>.json`.
  const projectStore = new ProjectStore(join(appDataDir(), 'projects'))

  const handlers = registerIpcHandlers(library, queue, () => (mainWindow ? [mainWindow] : []), engineClient, settingsStore, watchManager, projectStore, (ok) => closeGate?.ack(ok))
  cancelExport = handlers.cancelExport

  const notify = createRecordingNotifier(() => settingsStore!.get().recording)
  const pushLibrary = (): void => {
    const payload = queue!.payload()
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('library:updated', payload)
      } catch (error) {
        console.error('Failed to publish recording library update:', error)
      }
    }
  }
  recordingService = createRecordingService({
    onDiagnostic: reportChildDiagnostic,
    log: createDiagnosticLog(join(appDataDir(), 'recording.log')),
    getSettings: () => settingsStore!.get().recording,
    getObsPassword: () => obsPassword(settingsStore!.get().recording, safeStorage),
    probeVideo: async (file) => engineClient!.request('probe', sanitizeProbeArgs(file)).promise as Promise<import('../shared/types').VideoInfo>,
    getWatchFolders: () => settingsStore!.get().watchFolders,
    defaultOutputDir: join(app.getPath('videos'), 'Aditor'),
    recorderCommand: aditorrecCommand(app.isPackaged),
    ffmpegPath: ffmpegExecutable(app.isPackaged),
    profileDir: templateProfileDir,
    addToLibrary: (paths, game) => {
      library!.add(paths, 'recording', game)
      pushLibrary()
    },
    enqueueAnalysis: (videoPath) => queue!.enqueue(videoPath),
    notify,
    onGameExit: () => showMainWindow(),
    liveEngineCommand: liveEngineCommand(app.isPackaged),
    sceneDir: sceneDir(app.isPackaged),
    liveCachePath: (videoPath) => cacheFilePath(videoPath, cacheDir(), settingsStore!.get().cacheLocation === 'besideVideo'),
    // Live cache is already done, so the library entry can open immediately; if full analysis is queued next, the queue returns it to pending and replaces it when complete.
    onLiveAnalysis: (videoPath, summary) => {
      library!.update(videoPath, { status: 'done', progress: 1, counts: summary.counts, game: summary.game, durationSec: summary.durationSec, codec: summary.codec || undefined, hl: undefined })
      pushLibrary()
      void generateThumbnail(videoPath, summary.durationSec).then((thumb) => {
        if (!thumb || library!.get(videoPath)?.status !== 'done') return
        library!.update(videoPath, { thumb })
        pushLibrary()
      }, (error) => console.error('Failed to generate recording thumbnail:', error))
    }
  })
  unregisterRecordingIpc = registerRecordingIpc(recordingService, () => BrowserWindow.getAllWindows())
  tray = createRecordingTray({
    service: recordingService,
    iconDir: join(app.isPackaged ? process.resourcesPath : resolve(__dirname, '../..'), 'resources'),
    openWindow: showMainWindow,
    quit: () => app.quit(),
    notifyError: (message) => notify('error', message)
  })
  let launchAtLogin: boolean | undefined
  const updateLoginItem = (): void => {
    const enabled = settingsStore!.get().recording.launchAtLogin
    if (!app.isPackaged || enabled === launchAtLogin) return
    try {
      app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] })
      launchAtLogin = enabled
    } catch (error) {
      notify('error', tr('無法更新開機啟動設定：{error}', { error: String(error) }))
    }
  }
  updateLoginItem()
  const unsubscribeLogin = settingsStore.onChange(updateLoginItem)
  // Auto-update is enabled only in installed builds; E2E does not connect to GitHub.
  appUpdater = createAppUpdater({
    updater: !e2e && canAutoUpdate(app.isPackaged) ? await loadAutoUpdater() : null,
    isEnabled: () => settingsStore!.get().autoUpdate,
    notifyAvailable: (version) => notify('finalized', tr('Aditor {version} 有新版本可用，可在設定中選擇「下載更新」。', { version })),
    broadcast: broadcastUpdateStatus,
    // A manual install only requests quitting here; the quit guard starts the installer after finalization.
    requestQuit: () => app.quit()
  })
  const updater = appUpdater
  const unregisterUpdateIpc = registerUpdateIpc(updater)
  updater.start()
  const unsubscribeLanguage = settingsStore.onChange(() => {
    if (!syncLocale()) return
    tray?.refresh()
    if (mainWindow && !mainWindow.isDestroyed()) loadRenderer(mainWindow)
  })
  unsubscribeSettings = () => {
    unsubscribeLogin()
    unsubscribeLanguage()
    updater.stop()
    unregisterUpdateIpc()
  }
  // E2E does not detect real Apex to avoid interacting with a game running during tests.
  if (!e2e) recordingService.start()

  ipcMain.handle('engine:probe', async (_, videoPath: unknown) => {
    return engineClient?.request('probe', sanitizeProbeArgs(videoPath)).promise
  })

  ipcMain.handle('engine:analyze', async (event, args: unknown) => {
    // The renderer knows only the video path; main adds the engine's profile_dir/cache_dir (return directly on a cache hit).
    const req = engineClient?.request('analyze', buildAnalyzeArgs({ profile_dir: templateProfileDir, cache_dir: cacheDir() }, settingsStore?.get(), sanitizeAnalyzeArgs(args)), (progress) => {
      event.sender.send('engine:progress', progress)
    })
    return req?.promise
  })

  ipcMain.handle('engine:cancel', async (_, targetId: string) => {
    engineClient?.cancel(targetId)
    return { cancelled: true }
  })

  ipcMain.handle('engine:derive', async (_, args: unknown) => {
    return engineClient?.request('derive', { ...sanitizeDeriveArgs(args), profile_dir: templateProfileDir }).promise
  })

  ipcMain.handle('engine:autoclip', async (_, args: unknown) => {
    return engineClient?.request('autoclip', sanitizeAutoclipArgs(args)).promise
  })
}

// Before quitting, start export/proxy cancellation and folder-watching shutdown immediately, then always wait for recording
// finalization (including FFmpeg remux), flush the library and stop the engine (I7). Finalization is critical; remaining cleanup keeps its 5-second bound.
// A manual update install uses this same path and only spawns the NSIS installer after this guard finishes.
const quitGuard = createAppQuitGuard({
  stopRecording: () => recordingService?.stop(),
  flushLibrary: () => library?.flush(),
  stopEngine: () => engineClient?.stop(),
  cancelExport: () => cancelExport?.(),
  cancelProxies: async () => (await import('./proxy')).cancelAllProxies(),
  stopWatcher: () => watchManager?.stop(),
  installUpdate: () => appUpdater?.installIfRequested() ?? false,
  quit: () => app.quit(),
  timeoutMs: 5000
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  initializeTelemetry(loadSettings(join(appDataDir(), 'settings.json')).telemetryEnabled)
  app.on('second-instance', showMainWindow)
  app.whenReady().then(async () => {
    await initEngineAndServices()
    servicesReady = true
    if (openRequested) showMainWindow()
    if (e2e && process.env.ADITOR_SENTRY_VERIFY === '1') {
      const { verifyTelemetry } = await import('./telemetry-verification')
      const { writeFileSync } = await import('fs')
      writeFileSync(join(appDataDir(), 'sentry-verification.json'), JSON.stringify(await verifyTelemetry()))
    }
    app.on('activate', showMainWindow)
  })
  app.on('before-quit', (e) => {
    quitting = true
    quitGuard.onBeforeQuit(e)
  })
  app.on('will-quit', () => {
    unsubscribeSettings?.()
    unregisterRecordingIpc?.()
    tray?.destroy()
    tray = null
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !settingsStore?.get().recording.closeToTray) app.quit()
  })
}
