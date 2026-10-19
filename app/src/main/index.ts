import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron'
import { createQuitGuard } from './quit-guard'
import { delimiter, join, resolve } from 'path'
import { EngineClient } from './engine'
import { Library } from './library'
import { AnalysisQueue } from './queue'
import { SettingsStore } from './settings'
import { WatchManager } from './watch'
import { ProjectStore } from './projects'
import { registerIpcHandlers } from './ipc-handlers'
import { createCloseGate } from './project-ipc'
import { buildAnalyzeArgs } from './settings-derived'
import { currentE2EConfig } from './e2e'
import { applyWindowSecurity } from './window-security'
import { sanitizeAnalyzeArgs, sanitizeAutoclipArgs, sanitizeDeriveArgs, sanitizeProbeArgs } from './ipc-guards'
import { aditorrecCommand, appDataDir, cacheDir, chromiumUserDataDir, engineCommand, ffmpegExecutable, liveEngineCommand, profileDir, sceneDir } from '../shared/paths'
import { obsHookDir } from '../shared/paths'
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
import { canAutoUpdate, createAppUpdater } from './updater'
import { broadcastUpdateStatus, registerUpdateIpc } from './update-ipc'

// E2E 掛鉤（僅 ADITOR_E2E=1）：暫存 appData／userData，測試不碰使用者資料；正式執行時為 null
const e2e = currentE2EConfig()
if (e2e?.appData) process.env.APPDATA = e2e.appData
// 必須在 ready 前設定：預設 userData 的 Cache 與分析快取是同一個資料夾（見 chromiumUserDataDir）
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
let quitting = false
/** 目前生效的介面語言（設定 `language`，auto 時依 Windows 顯示語言） */
let locale: Locale = 'zh-TW'
let servicesReady = false
let openRequested = !process.argv.includes('--hidden')
/** renderer 未回應 flush 時最多等多久才關閉視窗 */
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
      // preload 只用 contextBridge／ipcRenderer，可以在沙箱內執行（I2）
      sandbox: true,
      contextIsolation: true
    }
  })

  applyWindowSecurity(mainWindow.webContents)

  // 關閉前先請 renderer 立即寫入最新專案（beforeunload 的 sendSync 之外的第二道保險）；
  // 收到 flushDone 或逾時才真正關閉
  const win = mainWindow
  const rendererAlive = (): boolean => !win.isDestroyed() && !win.webContents.isDestroyed() && !win.webContents.isCrashed()
  const shouldHide = (): boolean => !quitting && tray !== null && settingsStore?.get().recording.closeToTray === true
  const makeCloseGate = (): ReturnType<typeof createCloseGate> => createCloseGate({
    request: () => win.webContents.send('projects:flushRequest'),
    close: () => {
      if (shouldHide()) {
        win.hide()
        // 每次縮到系統匣後重新建立握手，下次關閉仍要儲存最新專案。
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
  // 縮到系統匣或最小化時請 renderer 暫停播放，不在背景繼續出聲
  const pausePlayback = (): void => {
    if (rendererAlive()) win.webContents.send('app:windowHidden')
  }
  win.on('hide', pausePlayback)
  win.on('minimize', pausePlayback)
  win.on('closed', () => {
    closeGate = null
    mainWindow = null
    // 視窗關閉：進行中的匯出一併取消，ffmpeg 不會變成孤兒（webContents 'destroyed' 也會觸發同一個取消）
    void cancelExport?.()
  })

  win.on('ready-to-show', () => {
    win.show()
    win.focus()
  })

  loadRenderer(mainWindow)
}

/** renderer 啟動時從網址的 `lang` 取得語言；換語言就用新的語言重新載入（未存檔的專案由 beforeunload 先寫入）。 */
function loadRenderer(win: BrowserWindow): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    url.searchParams.set('lang', locale)
    void win.loadURL(url.toString())
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query: { lang: locale } })
  }
}

/** 依設定重新決定介面語言；回傳語言是否有變。 */
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
  engineClient = new EngineClient(cmd)
  try {
    const res = await engineClient.start()
    console.log(`[Engine] Ready, version: ${res.engineVersion}`)
  } catch (err) {
    console.error('[Engine] Failed to start engine:', err)
  }

  // 上次中斷遺留的代理檔半成品
  ;(await import('./proxy')).cleanStaleProxyPartials()

  const templateProfileDir = profileDir(app.isPackaged)

  library = new Library(join(appDataDir(), 'library.json'))
  // 上次執行中斷遺留的「分析中」條目沒有佇列在處理，重設為閒置
  library.resetStaleAnalyzing()
  settingsStore = new SettingsStore(join(appDataDir(), 'settings.json'))
  syncLocale()
  queue = new AnalysisQueue(engineClient, library, {
    profileDir: templateProfileDir,
    cacheDir: cacheDir(),
    // decode／cacheLocation 每次分析時才讀取，設定變更免重啟
    getSettings: () => settingsStore?.get()
  })

  // 監看資料夾：依設定恢復；新影片自動匯入（autoAnalyze 開啟時排入佇列）
  watchManager = new WatchManager({ library, queue, settings: settingsStore })
  watchManager.start()

  // 專案自動儲存：`%APPDATA%\Aditor\projects\<id>.json`
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
        console.error('無法推送錄影媒體庫更新：', error)
      }
    }
  }
  recordingService = createRecordingService({
    log: createDiagnosticLog(join(appDataDir(), 'recording.log')),
    getSettings: () => settingsStore!.get().recording,
    getObsPassword: () => obsPassword(settingsStore!.get().recording, safeStorage),
    probeVideo: async (file) => engineClient!.request('probe', sanitizeProbeArgs(file)).promise as Promise<import('../shared/types').VideoInfo>,
    getWatchFolders: () => settingsStore!.get().watchFolders,
    defaultOutputDir: join(app.getPath('videos'), 'Aditor'),
    recorderCommand: aditorrecCommand(app.isPackaged),
    obsHookDir: obsHookDir(app.isPackaged),
    ffmpegPath: ffmpegExecutable(app.isPackaged),
    profileDir: templateProfileDir,
    addToLibrary: (paths) => {
      library!.add(paths)
      pushLibrary()
    },
    enqueueAnalysis: (videoPath) => queue!.enqueue(videoPath),
    notify,
    onGameExit: () => showMainWindow(),
    liveEngineCommand: liveEngineCommand(app.isPackaged),
    sceneDir: sceneDir(app.isPackaged),
    liveCachePath: (videoPath) => cacheFilePath(videoPath, cacheDir(), settingsStore!.get().cacheLocation === 'besideVideo'),
    // live 快取已是 done：媒體庫條目可直接開啟；若接著排完整分析，佇列會再改回等待中並在完成後覆蓋。
    onLiveAnalysis: (videoPath, summary) => {
      library!.update(videoPath, { status: 'done', progress: 1, counts: summary.counts, durationSec: summary.durationSec, codec: summary.codec || undefined, hl: undefined })
      pushLibrary()
      void generateThumbnail(videoPath, summary.durationSec).then((thumb) => {
        if (!thumb || library!.get(videoPath)?.status !== 'done') return
        library!.update(videoPath, { thumb })
        pushLibrary()
      }, (error) => console.error('無法產生錄影縮圖：', error))
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
  // 自動更新：只有安裝版；E2E 不連 GitHub
  const updater = createAppUpdater({
    updater: !e2e && canAutoUpdate(app.isPackaged) ? (await import('electron-updater')).autoUpdater : null,
    isEnabled: () => settingsStore!.get().autoUpdate,
    notifyDownloaded: (version) => notify('finalized', tr('Aditor {version} 已下載完成，結束 Aditor 時會自動安裝。', { version })),
    broadcast: broadcastUpdateStatus
  })
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
  // E2E 不偵測真實 Apex，避免測試期間碰到正在執行的遊戲
  if (!e2e) recordingService.start()

  ipcMain.handle('engine:probe', async (_, videoPath: unknown) => {
    return engineClient?.request('probe', sanitizeProbeArgs(videoPath)).promise
  })

  ipcMain.handle('engine:analyze', async (event, args: unknown) => {
    // renderer 只知道影片路徑；引擎需要的 profile_dir／cache_dir 由主程序補上（命中快取時直接回傳）
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

// 結束前等錄影收尾、匯出／代理檔 ffmpeg 被終止、引擎停止（I7）；逾時 5 秒仍會退出
const quitGuard = createQuitGuard({
  tasks: [
    () => library?.flush(),
    async () => {
      try { await recordingService?.stop() }
      finally {
        library?.flush()
        await engineClient?.stop()
      }
    },
    () => cancelExport?.(),
    async () => (await import('./proxy')).cancelAllProxies(),
    () => watchManager?.stop()
  ],
  quit: () => app.quit(),
  timeoutMs: 5000
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showMainWindow)
  app.whenReady().then(async () => {
    await initEngineAndServices()
    servicesReady = true
    if (openRequested) showMainWindow()
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
