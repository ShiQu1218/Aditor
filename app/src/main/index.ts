import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { EngineClient } from './engine'
import { engineCommand } from '../shared/paths'

let mainWindow: BrowserWindow | null = null
let engineClient: EngineClient | null = null

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

async function initEngine(): Promise<void> {
  const cmd = engineCommand(app.isPackaged)
  engineClient = new EngineClient(cmd)
  try {
    const res = await engineClient.start()
    console.log(`[Engine] Ready, version: ${res.engineVersion}`)
  } catch (err) {
    console.error('[Engine] Failed to start engine:', err)
  }

  ipcMain.handle('engine:probe', async (_, videoPath: string) => {
    return engineClient?.request('probe', { path: videoPath }).promise
  })

  ipcMain.handle('engine:analyze', async (event, args: Record<string, unknown>) => {
    const req = engineClient?.request('analyze', args, (progress) => {
      event.sender.send('engine:progress', progress)
    })
    return req?.promise
  })

  ipcMain.handle('engine:cancel', async (_, targetId: string) => {
    engineClient?.cancel(targetId)
    return { cancelled: true }
  })

  ipcMain.handle('engine:derive', async (_, args: Record<string, unknown>) => {
    return engineClient?.request('derive', args).promise
  })

  ipcMain.handle('engine:autoclip', async (_, args: Record<string, unknown>) => {
    return engineClient?.request('autoclip', args).promise
  })
}

app.whenReady().then(async () => {
  await initEngine()
  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    engineClient?.stop()
    app.quit()
  }
})
