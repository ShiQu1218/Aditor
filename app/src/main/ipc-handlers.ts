import { ipcMain, dialog, BrowserWindow, app } from 'electron'
import fs from 'fs'
import path from 'path'
import { Library, normalizePath } from './library'
import { AnalysisQueue } from './queue'
import { EngineClient } from './engine'
import { detectEncoders } from './export/encoders'
import { createExportService, registerExportHandlers } from './export/export-ipc'
import { hasOpenH264, downloadOpenH264 } from './codecs'
import { cacheFilePath, loadCacheDoc, saveCacheDoc } from './cache-io'
import { SettingsStore } from './settings'
import { WatchManager } from './watch'
import { ProjectStore } from './projects'
import { registerProjectHandlers } from './project-ipc'
import { fileExistsSafe } from './safe-path'
import { DEFAULT_SETTINGS, Settings } from '../shared/settings'
import { cacheDir, profileDir } from '../shared/paths'
import { computeHlCount, createHlGuard, createSerialQueue, hlForSavedDoc } from './hl'
import { createThrottle } from '../shared/throttle'
import type { CacheDoc, Clip } from '../shared/types'
import { handleProxyGenerate } from './proxy-ipc'
import { ProjectItem } from '../renderer/editor/project'
import { i18n } from '../renderer/i18n/zh-TW'

/** `library:updated` 廣播的最小間隔 */
export const LIBRARY_UPDATE_INTERVAL_MS = 500

const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.mov', '.webm'])

function findVideosInDir(dir: string): string[] {
  const results: string[] = []
  try {
    const list = fs.readdirSync(dir, { withFileTypes: true })
    for (const item of list) {
      const full = path.join(dir, item.name)
      if (item.isDirectory()) {
        results.push(...findVideosInDir(full))
      } else if (item.isFile()) {
        const ext = path.extname(item.name).toLowerCase()
        if (VIDEO_EXTS.has(ext)) {
          results.push(full)
        }
      }
    }
  } catch {}
  return results
}

export function registerIpcHandlers(
  library: Library,
  queue: AnalysisQueue,
  getWindows: () => BrowserWindow[],
  engine?: EngineClient,
  settings?: SettingsStore,
  watch?: WatchManager,
  projectStore?: ProjectStore,
  onProjectFlushDone?: () => void
): { cancelExport: () => Promise<void> } {
  // library:updated 最多每 500 ms 一次（前緣＋尾端，最後一次更新必定送達）；
  // 夾帶佇列的真實狀態（正在分析／排隊／進度／開始時間），renderer 不必為了佇列再拉整份 entries
  const sendUpdated = () => {
    const payload = queue.payload()
    for (const win of getWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('library:updated', payload)
      }
    }
  }
  const updatedThrottle = createThrottle(sendUpdated, LIBRARY_UPDATE_INTERVAL_MS)
  const broadcastUpdated = () => updatedThrottle.trigger()

  queue.on('update', () => {
    broadcastUpdated()
  })

  ipcMain.handle('queue:getState', () => queue.payload())

  ipcMain.handle('library:getEntries', () => {
    return library.getEntries()
  })

  ipcMain.handle('library:add', (_, paths: string[]) => {
    const added = library.add(paths)
    for (const entry of added) {
      queue.enqueue(entry.path)
    }
    broadcastUpdated()
    return added
  })

  ipcMain.handle('library:remove', (_, videoPath: string) => {
    queue.cancel(videoPath)
    const res = library.remove(videoPath)
    broadcastUpdated()
    return res
  })

  ipcMain.handle('library:toggleFavorite', (_, videoPath: string) => {
    const res = library.toggleFavorite(videoPath)
    broadcastUpdated()
    return res
  })

  ipcMain.handle('library:selectFiles', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const res = await dialog.showOpenDialog(win || undefined as unknown as BrowserWindow, {
      title: i18n.dialog.selectFilesTitle,
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: i18n.dialog.videoFilter, extensions: ['mp4', 'mkv', 'mov', 'webm'] }]
    })
    if (!res.canceled && res.filePaths.length > 0) {
      const added = library.add(res.filePaths)
      for (const entry of added) {
        queue.enqueue(entry.path)
      }
      broadcastUpdated()
      return added
    }
    return []
  })

  ipcMain.handle('library:selectFolder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const res = await dialog.showOpenDialog(win || undefined as unknown as BrowserWindow, {
      title: i18n.dialog.selectFolderTitle,
      properties: ['openDirectory']
    })
    if (!res.canceled && res.filePaths.length > 0) {
      const folder = res.filePaths[0]
      const videos = findVideosInDir(folder)
      if (videos.length > 0) {
        const added = library.add(videos)
        for (const entry of added) {
          queue.enqueue(entry.path)
        }
        broadcastUpdated()
        return added
      }
    }
    return []
  })

  // 路徑可能來自不受信任的專案檔：只接受本機絕對路徑＋影片副檔名的一般檔案（拒絕 UNC／裝置路徑，不碰網路）
  ipcMain.handle('library:fileExists', (_, videoPath: unknown) => fileExistsSafe(videoPath))

  // 惰性「N 精華」（spec §7.4）：卡片首次進入視窗且已分析完成、尚無記錄時，
  // 讀取既有快取（無副作用、絕不觸發 analyze；沒有快取＝略過）後以預設參數呼叫 autoclip，
  // 數字快取進 library.json。請求並行度 1、同一影片去重，避免捲動時 N 張卡片同時打引擎。
  const hlQueue = createSerialQueue<number | null>()
  const hlGuard = createHlGuard()
  ipcMain.handle('library:computeHl', (_, videoPath: string) => {
    const key = normalizePath(videoPath)
    const find = () => library.get(videoPath)
    const first = find()
    if (!first || first.status !== 'done' || first.hl !== undefined) return first?.hl ?? null
    if (!engine || hlGuard.isNegative(key)) return null
    return hlQueue.run(key, async () => {
      const entry = find()
      if (!entry || entry.status !== 'done') return null
      if (entry.hl !== undefined) return entry.hl
      if (hlGuard.isNegative(key)) return null
      const startedRev = hlGuard.rev(key)
      const doc = loadCacheDoc(cacheFilePath(videoPath, cacheDir())) as CacheDoc | null
      const params = settings?.get().autoclip ?? DEFAULT_SETTINGS.autoclip
      const count = await computeHlCount((cmd, args) => engine.request<unknown>(cmd, args).promise, doc, params)
      if (count === null) {
        hlGuard.markFailed(key)
        return null
      }
      // 計算期間若有較新的 cache:save（或條目已不是 done／被重新分析），丟棄這個舊結果
      const committed = hlGuard.commitIfCurrent(key, startedRev, () => {
        if (find()?.status === 'done') library.update(videoPath, { hl: count })
      })
      if (!committed) return find()?.hl ?? null
      broadcastUpdated()
      return count
    })
  })

  if (watch) {
    const watchStatus = (): { dirs: string[]; missing: string[] } => ({ dirs: watch.list(), missing: watch.missing() })

    watch.on('update', () => {
      broadcastUpdated()
    })

    ipcMain.handle('library:getWatchFolders', () => watchStatus())

    ipcMain.handle('library:addWatchFolder', async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const res = await dialog.showOpenDialog(win || (undefined as unknown as BrowserWindow), {
        title: i18n.dialog.addWatchFolderTitle,
        properties: ['openDirectory']
      })
      if (res.canceled || res.filePaths.length === 0) {
        return { ok: false, canceled: true, ...watchStatus() }
      }
      try {
        await watch.add(res.filePaths[0])
        broadcastUpdated()
        return { ok: true, ...watchStatus() }
      } catch (err) {
        return { ok: false, error: (err as Error).message, ...watchStatus() }
      }
    })

    ipcMain.handle('library:removeWatchFolder', async (_, dir: unknown) => {
      if (typeof dir !== 'string' || dir.length === 0) {
        return { ok: false, error: 'invalid folder path', ...watchStatus() }
      }
      await watch.remove(dir)
      broadcastUpdated()
      return { ok: true, ...watchStatus() }
    })
  }

  if (projectStore) {
    registerProjectHandlers(ipcMain, projectStore, settings, onProjectFlushDone)
  }

  ipcMain.handle('queue:enqueue', (_, videoPath: string) => {
    queue.enqueue(videoPath)
    broadcastUpdated()
  })

  ipcMain.handle('queue:cancel', (_, videoPath: string) => {
    queue.cancel(videoPath)
    broadcastUpdated()
  })

  ipcMain.handle('cache:load', async (_, cachePath: string) => loadCacheDoc(cachePath))

  // 由影片路徑推得快取檔（無副作用、不啟動分析）；工作室載入用
  ipcMain.handle('cache:loadByVideo', async (_, videoPath: string) => loadCacheDoc(cacheFilePath(videoPath, cacheDir())))

  // 工作室存檔時同步影片庫的「N 精華」＝目前待確認建議數（重新分析的建議尚未重算＝清除，交給惰性重算）。
  // 修訂號 bump：較早開始的 computeHl 不能再蓋掉這個較新的值
  ipcMain.handle(
    'cache:save',
    async (_, doc: { cache_path: string; video?: { path?: string }; clips?: Clip[]; app?: { suggestionsPending?: boolean } }) => {
      const ok = saveCacheDoc(doc)
      const videoPath = doc?.video?.path
      if (ok && videoPath && library.get(videoPath)) {
        hlGuard.bump(normalizePath(videoPath))
        library.update(videoPath, { hl: hlForSavedDoc(doc) })
        broadcastUpdated()
      }
      return ok
    }
  )

  ipcMain.handle('proxy:get', async (_, videoPath: string) => {
    const { proxyPath } = await import('./proxy')
    const p = proxyPath(videoPath)
    return fs.existsSync(p) ? p : null
  })

  ipcMain.handle('proxy:generate', async (event, videoPath: unknown, durationSec?: unknown) => {
    const { generateProxy } = await import('./proxy')
    // 進度只推給發出請求的視窗
    return handleProxyGenerate(event.sender, videoPath, durationSec, { generateProxy })
  })

  ipcMain.handle('proxy:delete', async (_, videoPath: string) => {
    const { proxyPath } = await import('./proxy')
    const p = proxyPath(videoPath)
    if (fs.existsSync(p)) {
      fs.unlinkSync(p)
      return true
    }
    return false
  })

  ipcMain.handle('project:showSaveDialog', async (event, defaultName?: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const res = await dialog.showSaveDialog(win || (undefined as unknown as BrowserWindow), {
      title: i18n.dialog.saveProjectTitle,
      defaultPath: defaultName || 'project.apexproj.json',
      filters: [{ name: 'Apex Highlighter Project', extensions: ['apexproj.json', 'json'] }]
    })
    return res.canceled ? null : res.filePath
  })

  ipcMain.handle('project:showOpenDialog', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const res = await dialog.showOpenDialog(win || (undefined as unknown as BrowserWindow), {
      title: i18n.dialog.openProjectTitle,
      properties: ['openFile'],
      filters: [{ name: 'Apex Highlighter Project', extensions: ['apexproj.json', 'json'] }]
    })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  ipcMain.handle('project:save', async (_, filePath: string, content: string) => {
    try {
      const dir = path.dirname(filePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      fs.writeFileSync(filePath, content, 'utf-8')
      return true
    } catch (err) {
      console.error('Failed to save project:', err)
      return false
    }
  })

  ipcMain.handle('project:load', async (_, filePath: string) => {
    try {
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf-8')
      }
    } catch (err) {
      console.error('Failed to load project:', err)
    }
    return null
  })

  ipcMain.handle('export:detectEncoders', async () => {
    return detectEncoders()
  })

  ipcMain.handle('export:openh264Status', async () => {
    return { installed: hasOpenH264() }
  })

  ipcMain.handle('export:downloadOpenH264', async () => {
    return downloadOpenH264()
  })

  ipcMain.handle('export:selectOutDir', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const res = await dialog.showOpenDialog(win || (undefined as unknown as BrowserWindow), {
      title: i18n.dialog.selectOutDirTitle,
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  // 匯出：start／cancel／diskSpace（驗證、單一匯出、視窗關閉即取消都在 export-ipc.ts）
  const exportService = createExportService({
    probe: engine ? (source) => engine.request('probe', { path: source }).promise : undefined
  })
  registerExportHandlers(ipcMain, exportService)

  if (settings) {
    settings.onChange((current) => {
      for (const win of getWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('settings:changed', current)
        }
      }
    })

    ipcMain.handle('settings:get', () => settings.get())

    ipcMain.handle('settings:set', (_, partial: Partial<Settings>) => settings.set(partial))
  }

  return { cancelExport: () => exportService.cancelAndWait() }
}
