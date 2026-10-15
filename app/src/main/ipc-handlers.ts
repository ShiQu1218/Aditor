import { ipcMain, dialog, BrowserWindow, app } from 'electron'
import fs from 'fs'
import path from 'path'
import { Library, normalizePath } from './library'
import { AnalysisQueue } from './queue'
import { EngineClient } from './engine'
import { detectEncoders } from './export/encoders'
import { buildJobs, estimateOutputBytes, escapeConcatPath, StreamProbe } from './export/plan'
import { executeExportJobs } from './export/run'
import { hasOpenH264, downloadOpenH264 } from './codecs'
import { cacheFilePath, loadCacheDoc, saveCacheDoc } from './cache-io'
import { SettingsStore } from './settings'
import { WatchManager } from './watch'
import { ProjectStore, StoredProject } from './projects'
import { DEFAULT_SETTINGS, Settings } from '../shared/settings'
import { cacheDir, profileDir } from '../shared/paths'
import { computeHlCount, createSerialQueue, hlFromClips } from './hl'
import type { CacheDoc, Clip } from '../shared/types'
import { handleProxyGenerate } from './proxy-ipc'
import { ProjectItem } from '../renderer/editor/project'
import { i18n } from '../renderer/i18n/zh-TW'

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
  projectStore?: ProjectStore
): void {
  const broadcastUpdated = () => {
    for (const win of getWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('library:updated')
      }
    }
  }

  queue.on('update', () => {
    broadcastUpdated()
  })

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

  ipcMain.handle('library:fileExists', (_, videoPath: string) => {
    try {
      return fs.existsSync(videoPath)
    } catch {
      return false
    }
  })

  // 惰性「N 精華」（spec §7.4）：卡片首次進入視窗且已分析完成、尚無記錄時，
  // 讀取既有快取（無副作用、絕不觸發 analyze；沒有快取＝略過）後以預設參數呼叫 autoclip，
  // 數字快取進 library.json。請求並行度 1、同一影片去重，避免捲動時 N 張卡片同時打引擎。
  const hlQueue = createSerialQueue<number | null>()
  ipcMain.handle('library:computeHl', (_, videoPath: string) => {
    const find = () => library.getEntries().find((e) => normalizePath(e.path) === normalizePath(videoPath))
    const first = find()
    if (!first || first.status !== 'done' || first.hl !== undefined) return first?.hl ?? null
    if (!engine) return null
    return hlQueue.run(normalizePath(videoPath), async () => {
      const entry = find()
      if (!entry || entry.status !== 'done') return null
      if (entry.hl !== undefined) return entry.hl
      const doc = loadCacheDoc(cacheFilePath(videoPath, cacheDir())) as CacheDoc | null
      const params = settings?.get().autoclip ?? DEFAULT_SETTINGS.autoclip
      const count = await computeHlCount((cmd, args) => engine.request<unknown>(cmd, args).promise, doc, params)
      if (count === null) return null
      library.update(videoPath, { hl: count })
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
    ipcMain.handle('projects:save', async (_, p: StoredProject) => {
      await projectStore.save(p)
      return true
    })

    ipcMain.handle('projects:load', async (_, id: string) => projectStore.load(id))

    ipcMain.handle('projects:list', async () => projectStore.list())

    ipcMain.handle('projects:remove', async (_, id: string) => {
      await projectStore.remove(id)
      return true
    })
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

  // 工作室存檔時同步影片庫的「N 精華」（目前待確認建議數；沒有 AI 片段則清除，交給惰性重算）
  ipcMain.handle('cache:save', async (_, doc: { cache_path: string; video?: { path?: string }; clips?: Clip[] }) => {
    const ok = saveCacheDoc(doc)
    const videoPath = doc?.video?.path
    if (ok && videoPath && library.getEntries().some((e) => normalizePath(e.path) === normalizePath(videoPath))) {
      library.update(videoPath, { hl: hlFromClips(doc.clips) })
      broadcastUpdated()
    }
    return ok
  })

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

  ipcMain.handle(
    'export:run',
    async (
      event,
      opts: {
        items: ProjectItem[]
        mode: 'separate' | 'concat'
        quality: 'copy' | 'precise'
        encoder?: string
        outDir: string
        baseName: string
      }
    ) => {
      try {
        const probes = new Map<string, StreamProbe>()
        for (const item of opts.items) {
          if (!probes.has(item.source)) {
            let probeInfo: StreamProbe = {
              vcodec: 'h264',
              width: 1920,
              height: 1080,
              fps: 60,
              pix_fmt: 'yuv420p',
              acodec: 'aac',
              sample_rate: 48000,
              channels: 2
            }
            if (engine) {
              try {
                const info = (await engine.request('probe', { path: item.source }).promise) as any
                if (info) {
                  probeInfo = {
                    ...probeInfo,
                    vcodec: info.codec || 'h264',
                    width: info.width || 1920,
                    height: info.height || 1080
                  }
                }
              } catch {}
            }
            probes.set(item.source, probeInfo)
          }
        }

        const { jobs, notices } = buildJobs(opts.items, opts, probes)
        const estimatedBytes = estimateOutputBytes(opts.items, opts.quality, probes)
        let totalDur = 0
        for (const item of opts.items) {
          totalDur += Math.max(0, item.end - item.start)
        }

        let concatListContent: string | undefined
        if (opts.mode === 'concat') {
          const lines: string[] = []
          for (const item of opts.items) {
            lines.push(`file ${escapeConcatPath(item.source)}`)
            lines.push(`inpoint ${item.start.toFixed(3)}`)
            lines.push(`outpoint ${item.end.toFixed(3)}`)
          }
          concatListContent = lines.join('\n') + '\n'
        }

        const win = BrowserWindow.fromWebContents(event.sender)
        const outputs = await executeExportJobs(
          jobs,
          totalDur,
          opts.outDir,
          estimatedBytes,
          concatListContent,
          (progress) => {
            if (win && !win.isDestroyed()) {
              win.webContents.send('export:progress', progress)
            }
          }
        )

        return { ok: true, outputs, notices }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

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
}
