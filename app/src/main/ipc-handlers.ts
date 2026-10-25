import { ipcMain, dialog, BrowserWindow, app, shell, safeStorage } from 'electron'
import fs from 'fs'
import path from 'path'
import { Library, normalizePath } from './library'
import { AnalysisQueue } from './queue'
import { EngineClient } from './engine'
import { detectEncoders } from './export/encoders'
import { createExportService, registerExportHandlers } from './export/export-ipc'
import { hasOpenH264, downloadOpenH264 } from './codecs'
import { loadCacheWithEdits, saveCacheEdits } from './reanalysis'
import { SettingsStore } from './settings'
import { registerSettingsHandlers } from './settings-ipc'
import { WatchManager } from './watch'
import { ProjectStore } from './projects'
import { registerProjectHandlers } from './project-ipc'
import { fileExistsSafe, isSafeLocalDirPath, isSafeLocalVideoPath } from './safe-path'
import { planCacheSave, requireVideoPath, sanitizeRemoveOptions } from './ipc-guards'
import { isGameId } from '../shared/games'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { currentE2EConfig } from './e2e'
import { cacheDir, noticesFile } from '../shared/paths'
import { computeHlCount, createHlGuard, createSerialQueue, hlForSavedDoc } from './hl'
import { createThrottle } from '../shared/throttle'
import type { CacheDoc, Clip } from '../shared/types'
import { handleProxyGenerate, handleProxyUsage } from './proxy-ipc'
import { mediaCacheIsCurrent } from './media-cache'
import { catalogFor } from '../renderer/i18n'
import { getActiveLocale, tr } from '../shared/locale'

/** Native dialog text (follows the current interface language). */
const dialogText = (): ReturnType<typeof catalogFor>['i18n']['dialog'] => catalogFor(getActiveLocale()).i18n.dialog

/** Minimum interval between `library:updated` broadcasts. */
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
  onProjectFlushDone?: (ok: boolean) => void
): { cancelExport: () => Promise<void> } {
  // Read cache-location settings each time so changes take effect without a restart; follows the engine analyze beside rule.
  const cacheBeside = (): boolean => settings?.get().cacheLocation === 'besideVideo'
  // Send library:updated at most every 500 ms (leading and trailing edge, so the final update is always delivered).
  // Include actual queue state (analyzing/queued/progress/start time), so the renderer does not need to fetch all entries again for queue state.
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

  ipcMain.handle('library:getLoadNotice', () => library.corruptBackup)

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

  ipcMain.handle('library:remove', async (_, videoPath: string, options?: unknown) => {
    const res = await queue.withStoppedAnalysis([videoPath], () => library.remove(videoPath, sanitizeRemoveOptions(options)))
    broadcastUpdated()
    return res
  })

  // Bulk removal for selection mode: one broadcast and one save; invalid arguments are a no-op.
  ipcMain.handle('library:removeMany', async (_, paths: unknown, options?: unknown) => {
    if (!Array.isArray(paths) || !paths.every((p): p is string => typeof p === 'string')) {
      return { removed: [], failed: [] }
    }
    const res = await queue.withStoppedAnalysis(paths, () => library.removeMany(paths, sanitizeRemoveOptions(options)))
    broadcastUpdated()
    return res
  })

  /** The user says which game a video shows (after recognition failed, or to correct it); analyze it as that game. */
  ipcMain.handle('library:setGame', (_, videoPath: unknown, game: unknown) => {
    if (typeof videoPath !== 'string' || !isGameId(game) || !library.get(videoPath)) return false
    library.update(videoPath, { game, status: 'pending', progress: 0, error: undefined, errorCode: undefined })
    queue.enqueue(videoPath)
    broadcastUpdated()
    return true
  })

  ipcMain.handle('library:toggleFavorite', (_, videoPath: string) => {
    const res = library.toggleFavorite(videoPath)
    broadcastUpdated()
    return res
  })

  ipcMain.handle('library:selectFiles', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const res = await dialog.showOpenDialog(win || undefined as unknown as BrowserWindow, {
      title: dialogText().selectFilesTitle,
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: dialogText().videoFilter, extensions: ['mp4', 'mkv', 'mov', 'webm'] }]
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
      title: dialogText().selectFolderTitle,
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

  // Paths may come from untrusted project files: accept only regular files with local absolute paths and video extensions (reject UNC/device paths without touching the network).
  ipcMain.handle('library:fileExists', (_, videoPath: unknown) => fileExistsSafe(videoPath))

  // Lazy "N highlights" (spec §7.4): when a card first enters the viewport, analysis is complete, and no count is stored,
  // read the existing cache (no side effects and never triggers analyze; skip when there is no cache), call autoclip with default parameters,
  // and cache the number in library.json. Concurrency is 1 and requests for the same video are deduplicated, avoiding simultaneous engine calls while scrolling.
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
      const doc = loadCacheWithEdits(videoPath, cacheDir(), cacheBeside()) as CacheDoc | null
      const params = settings?.get().autoclip ?? DEFAULT_SETTINGS.autoclip
      const count = await computeHlCount((cmd, args) => engine.request<unknown>(cmd, args).promise, doc, params)
      if (count === null) {
        hlGuard.markFailed(key)
        return null
      }
      // Discard this result if a newer cache:save occurred during computation (or the entry is no longer done/has been reanalyzed).
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
        title: dialogText().addWatchFolderTitle,
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

  ipcMain.handle('queue:enqueue', (_, videoPath: unknown, force?: unknown) => {
    queue.enqueue(requireVideoPath(videoPath), force === true)
    broadcastUpdated()
  })

  ipcMain.handle('queue:cancel', (_, videoPath: string) => {
    queue.cancel(videoPath)
    broadcastUpdated()
  })

  // Derive the cache file from the video path (no side effects and no analysis); used when Studio loads.
  ipcMain.handle('cache:loadByVideo', async (_, videoPath: string) => loadCacheWithEdits(videoPath, cacheDir(), cacheBeside()))

  // When Studio saves, sync library "N highlights" with the current pending-suggestion count (clear it when post-reanalysis suggestions have not been recomputed, so lazy computation can handle it).
  // Bump the revision so an older computeHl cannot overwrite this newer value.
  // Main derives the destination from the video path (ignores renderer cache_path); the video must be in the library (I1).
  type SavedDoc = { cache_path?: string; video?: { path?: string }; clips?: Clip[]; app?: { suggestionsPending?: boolean } }
  const saveCacheFromRenderer = (doc: SavedDoc): boolean => {
    const plan = planCacheSave(doc, library, cacheDir(), cacheBeside())
    if (!plan) return false
    const ok = saveCacheEdits(plan.doc as CacheDoc, cacheDir(), cacheBeside(), queue.activeCachePath?.(doc.video!.path!))
    const videoPath = doc.video?.path
    if (ok && videoPath) {
      hlGuard.bump(normalizePath(videoPath))
      library.update(videoPath, { hl: hlForSavedDoc(plan.doc) })
      broadcastUpdated()
    }
    return ok
  }
  ipcMain.handle('cache:save', async (_, doc: SavedDoc) => saveCacheFromRenderer(doc))
  // Used when leaving Studio or closing the window: block until the cache has been written to disk (I4).
  ipcMain.on('cache:saveSync', (event, doc: SavedDoc) => {
    try {
      event.returnValue = saveCacheFromRenderer(doc)
    } catch (err) {
      console.error('[Cache] saveSync failed:', err)
      event.returnValue = false
    }
  })

  ipcMain.handle('proxy:get', async (_, videoPath: unknown) => {
    if (!isSafeLocalVideoPath(videoPath)) return null
    const { proxyPath } = await import('./proxy')
    const p = proxyPath(videoPath)
    return mediaCacheIsCurrent(videoPath, p) ? p : null
  })

  ipcMain.handle('proxy:generate', async (event, videoPath: unknown, durationSec?: unknown) => {
    const { generateProxy } = await import('./proxy')
    // Send progress only to the requesting window.
    return handleProxyGenerate(event.sender, videoPath, durationSec, { generateProxy })
  })

  ipcMain.handle('proxy:usage', async (_, videoPaths: unknown) => {
    const { proxyPath } = await import('./proxy')
    return handleProxyUsage(videoPaths, {
      proxyPath,
      statSize: (file) => {
        try {
          return fs.statSync(file).size
        } catch {
          return null
        }
      }
    })
  })

  ipcMain.handle('proxy:delete', async (_, videoPath: unknown) => {
    if (!isSafeLocalVideoPath(videoPath)) return false
    const { proxyPath } = await import('./proxy')
    const p = proxyPath(videoPath)
    if (fs.existsSync(p)) {
      fs.unlinkSync(p)
      fs.rmSync(p + '.source', { force: true })
      return true
    }
    return false
  })

  // Open the bundled third-party notices with the system's default application (I11).
  ipcMain.handle('app:openLicenses', async () => {
    const file = noticesFile(app.isPackaged)
    if (!fs.existsSync(file)) return false
    return (await shell.openPath(file)) === ''
  })

  ipcMain.handle('export:detectEncoders', async () => {
    return detectEncoders()
  })

  ipcMain.handle('export:openh264Status', async () => {
    return { installed: hasOpenH264() }
  })

  // OpenH264 download: codecs.ts validates the allowlisted URL, size, and hash; send progress only to the requesting window; allow one download at a time.
  let h264Downloading: Promise<string> | null = null
  ipcMain.handle('export:downloadOpenH264', async (event) => {
    if (h264Downloading) throw new Error(tr('OpenH264 正在下載中'))
    h264Downloading = downloadOpenH264({
      onProgress: (ratio) => {
        if (!event.sender.isDestroyed()) event.sender.send('export:openh264Progress', ratio)
      }
    })
    try {
      const dll = await h264Downloading
      // Re-detect proxy encoders after installing OpenH264.
      ;(await import('./proxy')).resetProxyEncoderCache()
      return dll
    } finally {
      h264Downloading = null
    }
  })

  // Open an output folder; accept only existing local absolute directory paths.
  ipcMain.handle('export:openFolder', async (_event, dir: unknown) => {
    if (!isSafeLocalDirPath(dir)) return false
    const st = await fs.promises.stat(dir).catch(() => null)
    if (!st || !st.isDirectory()) return false
    return (await shell.openPath(dir)) === ''
  })

  ipcMain.handle('export:selectOutDir', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const res = await dialog.showOpenDialog(win || (undefined as unknown as BrowserWindow), {
      title: dialogText().selectOutDirTitle,
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  // Export: start/cancel/diskSpace (validation, single-export enforcement, and cancel-on-window-close are in export-ipc.ts).
  const exportService = createExportService({
    // Set only for E2E (ADITOR_E2E_FAKE_FFMPEG=1); undefined in production to use the default ffmpeg.
    ffmpeg: currentE2EConfig()?.exportFfmpeg ?? undefined,
    probe: engine ? (source) => engine.request('probe', { path: source }).promise : undefined
  })
  registerExportHandlers(ipcMain, exportService)

  if (settings) {
    registerSettingsHandlers(ipcMain, settings, getWindows, safeStorage, () => app.getPath('videos'))
  }

  return { cancelExport: () => exportService.cancelAndWait() }
}
