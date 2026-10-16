import { app, BrowserWindow, ipcMain } from 'electron'
import { join, resolve } from 'path'
import { EngineClient } from './engine'
import { Library } from './library'
import { AnalysisQueue } from './queue'
import { SettingsStore } from './settings'
import { WatchManager } from './watch'
import { ProjectStore } from './projects'
import { registerIpcHandlers } from './ipc-handlers'
import { createCloseGate } from './project-ipc'
import { buildAnalyzeArgs, resolveAnalyzeProfileDir } from './settings-derived'
import { currentE2EConfig } from './e2e'
import { applyWindowSecurity } from './window-security'
import { sanitizeAnalyzeArgs, sanitizeAutoclipArgs, sanitizeDeriveArgs, sanitizeProbeArgs } from './ipc-guards'
import { appDataDir, cacheDir, engineCommand, ffmpegExecutable, profileDir } from '../shared/paths'

// E2E 掛鉤（僅 APEXHL_E2E=1）：暫存 appData／userData，測試不碰使用者資料；正式執行時為 null
const e2e = currentE2EConfig()
if (e2e?.appData) {
  process.env.APPDATA = e2e.appData
  app.setPath('userData', join(e2e.appData, 'electron-userdata'))
}

let mainWindow: BrowserWindow | null = null
let engineClient: EngineClient | null = null
let library: Library | null = null
let queue: AnalysisQueue | null = null
let settingsStore: SettingsStore | null = null
let watchManager: WatchManager | null = null
let closeGate: ReturnType<typeof createCloseGate> | null = null
let cancelExport: (() => Promise<void>) | null = null
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
  closeGate = createCloseGate({
    request: () => win.webContents.send('projects:flushRequest'),
    close: () => win.close(),
    timeoutMs: CLOSE_FLUSH_TIMEOUT_MS,
    rendererAlive: () => !win.isDestroyed() && !win.webContents.isDestroyed() && !win.webContents.isCrashed()
  })
  win.on('close', (e) => closeGate?.onClose(e))
  win.on('closed', () => {
    closeGate = null
    // 視窗關閉：進行中的匯出一併取消，ffmpeg 不會變成孤兒（webContents 'destroyed' 也會觸發同一個取消）
    void cancelExport?.()
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

async function initEngineAndServices(): Promise<void> {
  if (app.isPackaged) {
    const ffmpegPath = ffmpegExecutable(true)
    process.env.APEXHL_FFMPEG = ffmpegPath
    const binDir = resolve(join(ffmpegPath, '..'))
    process.env.PATH = `${binDir}${resolve(join(__dirname, '..')) ? ';' : ''}${process.env.PATH || ''}`
  }

  const cmd = e2e?.fakeEngine ?? engineCommand(app.isPackaged)
  engineClient = new EngineClient(cmd)
  try {
    const res = await engineClient.start()
    console.log(`[Engine] Ready, version: ${res.engineVersion}`)
  } catch (err) {
    console.error('[Engine] Failed to start engine:', err)
  }

  const templateProfileDir = profileDir(app.isPackaged)

  library = new Library(join(appDataDir(), 'library.json'))
  // 上次執行中斷遺留的「分析中」條目沒有佇列在處理，重設為閒置
  library.resetStaleAnalyzing()
  // 啟動時讀取設定：無檔案＝新安裝，gameLang 預設 'auto'；舊設定檔缺 gameLang → 'zh-TW'（行為與舊版相同）
  settingsStore = new SettingsStore(join(appDataDir(), 'settings.json'))
  queue = new AnalysisQueue(engineClient, library, {
    profileDir: templateProfileDir,
    cacheDir: cacheDir(),
    // decode／cacheLocation 每次分析時才讀取，設定變更免重啟
    getSettings: () => settingsStore?.get()
  })

  // 監看資料夾：依設定恢復；新影片自動匯入（autoAnalyze 開啟時排入佇列）
  watchManager = new WatchManager({ library, queue, settings: settingsStore })
  watchManager.start()

  // 專案自動儲存：`%APPDATA%\ApexHighlighter\projects\<id>.json`
  const projectStore = new ProjectStore(join(appDataDir(), 'projects'))

  const handlers = registerIpcHandlers(library, queue, () => (mainWindow ? [mainWindow] : []), engineClient, settingsStore, watchManager, projectStore, () => closeGate?.ack())
  cancelExport = handlers.cancelExport

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
    return engineClient?.request('derive', { ...sanitizeDeriveArgs(args), profile_dir: resolveAnalyzeProfileDir(templateProfileDir, settingsStore?.get()) }).promise
  })

  ipcMain.handle('engine:autoclip', async (_, args: unknown) => {
    return engineClient?.request('autoclip', sanitizeAutoclipArgs(args)).promise
  })
}

app.whenReady().then(async () => {
  await initEngineAndServices()
  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  void cancelExport?.()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    watchManager?.stop()
    engineClient?.stop()
    app.quit()
  }
})
