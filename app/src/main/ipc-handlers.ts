import { ipcMain, dialog, BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import { Library } from './library'
import { AnalysisQueue } from './queue'

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
  getWindows: () => BrowserWindow[]
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
      title: '選擇 Apex Legends 錄影檔案',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '影片檔案', extensions: ['mp4', 'mkv', 'mov', 'webm'] }]
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
      title: '選擇包含錄影的資料夾',
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

  ipcMain.handle('queue:enqueue', (_, videoPath: string) => {
    queue.enqueue(videoPath)
    broadcastUpdated()
  })

  ipcMain.handle('queue:cancel', (_, videoPath: string) => {
    queue.cancel(videoPath)
    broadcastUpdated()
  })

  ipcMain.handle('cache:load', async (_, cachePath: string) => {
    try {
      if (fs.existsSync(cachePath)) {
        const raw = fs.readFileSync(cachePath, 'utf-8')
        return JSON.parse(raw)
      }
    } catch (err) {
      console.error('Failed to load cache:', err)
    }
    return null
  })

  ipcMain.handle('cache:save', async (_, doc: { cache_path: string }) => {
    try {
      if (doc && doc.cache_path) {
        const dest = doc.cache_path
        const dir = path.dirname(dest)
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }
        const tmp = `${dest}.tmp`
        fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf-8')
        fs.renameSync(tmp, dest)
        return true
      }
    } catch (err) {
      console.error('Failed to save cache:', err)
    }
    return false
  })

  ipcMain.handle('proxy:get', async (_, videoPath: string) => {
    const { proxyPath } = await import('./proxy')
    const p = proxyPath(videoPath)
    return fs.existsSync(p) ? p : null
  })

  ipcMain.handle('proxy:generate', async (_, videoPath: string) => {
    const { generateProxy } = await import('./proxy')
    return generateProxy(videoPath)
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
      title: '儲存剪輯專案',
      defaultPath: defaultName || 'project.apexproj.json',
      filters: [{ name: 'Apex Highlighter Project', extensions: ['apexproj.json', 'json'] }]
    })
    return res.canceled ? null : res.filePath
  })

  ipcMain.handle('project:showOpenDialog', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const res = await dialog.showOpenDialog(win || (undefined as unknown as BrowserWindow), {
      title: '開啟剪輯專案',
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
}
