import { app, BrowserWindow, ipcMain } from 'electron'
import { join, resolve } from 'path'
import { EngineClient } from './engine'
import { Library } from './library'
import { AnalysisQueue } from './queue'
import { SettingsStore } from './settings'
import { WatchManager } from './watch'
import { ProjectStore } from './projects'
import { registerIpcHandlers } from './ipc-handlers'
import { appDataDir, cacheDir, engineCommand, ffmpegExecutable, profileDir } from '../shared/paths'

let mainWindow: BrowserWindow | null = null
let engineClient: EngineClient | null = null
let library: Library | null = null
let queue: AnalysisQueue | null = null
let settingsStore: SettingsStore | null = null
let watchManager: WatchManager | null = null

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
      sandbox: false,
      contextIsolation: true
    }
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

  const cmd = engineCommand(app.isPackaged)
  engineClient = new EngineClient(cmd)
  try {
    const res = await engineClient.start()
    console.log(`[Engine] Ready, version: ${res.engineVersion}`)
  } catch (err) {
    console.error('[Engine] Failed to start engine:', err)
  }

  const templateProfileDir = profileDir(app.isPackaged)

  library = new Library(join(appDataDir(), 'library.json'))
  // 啟動時讀取設定；無檔案＝首次使用者，採預設值（行為與舊版相同）
  settingsStore = new SettingsStore(join(appDataDir(), 'settings.json'))
  queue = new AnalysisQueue(engineClient, library, {
    profileDir: templateProfileDir,
    cacheDir: cacheDir()
  })

  // 監看資料夾：依設定恢復；新影片自動匯入（autoAnalyze 開啟時排入佇列）
  watchManager = new WatchManager({ library, queue, settings: settingsStore })
  watchManager.start()

  // 專案自動儲存：`%APPDATA%\ApexHighlighter\projects\<id>.json`
  const projectStore = new ProjectStore(join(appDataDir(), 'projects'))

  registerIpcHandlers(library, queue, () => (mainWindow ? [mainWindow] : []), engineClient, settingsStore, watchManager, projectStore)

  ipcMain.handle('engine:probe', async (_, videoPath: string) => {
    return engineClient?.request('probe', { path: videoPath }).promise
  })

  ipcMain.handle('engine:analyze', async (event, args: Record<string, unknown>) => {
    // renderer 只知道影片路徑；引擎需要的 profile_dir／cache_dir 由主程序補上（命中快取時直接回傳）
    const req = engineClient?.request('analyze', { profile_dir: templateProfileDir, cache_dir: cacheDir(), ...args }, (progress) => {
      event.sender.send('engine:progress', progress)
    })
    return req?.promise
  })

  ipcMain.handle('engine:cancel', async (_, targetId: string) => {
    engineClient?.cancel(targetId)
    return { cancelled: true }
  })

  ipcMain.handle('engine:derive', async (_, args: Record<string, unknown>) => {
    return engineClient?.request('derive', { profile_dir: templateProfileDir, ...args }).promise
  })

  ipcMain.handle('engine:autoclip', async (_, args: Record<string, unknown>) => {
    return engineClient?.request('autoclip', args).promise
  })
}

app.whenReady().then(async () => {
  await initEngineAndServices()
  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    watchManager?.stop()
    engineClient?.stop()
    app.quit()
  }
})
