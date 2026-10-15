import { contextBridge, ipcRenderer } from 'electron'

const api = {
  engine: {
    probe: (path: string) => ipcRenderer.invoke('engine:probe', path),
    analyze: (args: unknown) => ipcRenderer.invoke('engine:analyze', args),
    cancel: (targetId: string) => ipcRenderer.invoke('engine:cancel', targetId),
    derive: (args: unknown) => ipcRenderer.invoke('engine:derive', args),
    autoclip: (args: unknown) => ipcRenderer.invoke('engine:autoclip', args),
    onProgress: (callback: (data: { t: number; duration: number }) => void) => {
      const handler = (_: unknown, data: { t: number; duration: number }) => callback(data)
      ipcRenderer.on('engine:progress', handler)
      return () => {
        ipcRenderer.removeListener('engine:progress', handler)
      }
    }
  },
  library: {
    getEntries: () => ipcRenderer.invoke('library:getEntries'),
    add: (paths: string[]) => ipcRenderer.invoke('library:add', paths),
    remove: (path: string) => ipcRenderer.invoke('library:remove', path),
    toggleFavorite: (path: string) => ipcRenderer.invoke('library:toggleFavorite', path),
    selectFiles: () => ipcRenderer.invoke('library:selectFiles'),
    selectFolder: () => ipcRenderer.invoke('library:selectFolder'),
    getWatchFolders: () => ipcRenderer.invoke('library:getWatchFolders'),
    addWatchFolder: () => ipcRenderer.invoke('library:addWatchFolder'),
    removeWatchFolder: (dir: string) => ipcRenderer.invoke('library:removeWatchFolder', dir),
    fileExists: (path: string) => ipcRenderer.invoke('library:fileExists', path),
    computeHl: (path: string) => ipcRenderer.invoke('library:computeHl', path),
    onUpdated: (callback: (payload?: unknown) => void) => {
      const handler = (_: unknown, payload?: unknown) => callback(payload)
      ipcRenderer.on('library:updated', handler)
      return () => {
        ipcRenderer.removeListener('library:updated', handler)
      }
    }
  },
  queue: {
    enqueue: (path: string) => ipcRenderer.invoke('queue:enqueue', path),
    cancel: (path: string) => ipcRenderer.invoke('queue:cancel', path),
    /** 佇列的真實狀態（正在分析／排隊／進度／開始時間） */
    getState: () => ipcRenderer.invoke('queue:getState')
  },
  cache: {
    load: (path: string) => ipcRenderer.invoke('cache:load', path),
    loadByVideo: (videoPath: string) => ipcRenderer.invoke('cache:loadByVideo', videoPath),
    save: (doc: unknown) => ipcRenderer.invoke('cache:save', doc)
  },
  proxy: {
    get: (videoPath: string) => ipcRenderer.invoke('proxy:get', videoPath),
    generate: (videoPath: string, durationSec?: number) => ipcRenderer.invoke('proxy:generate', videoPath, durationSec),
    onProgress: (callback: (data: { videoPath: string; ratio: number }) => void) => {
      const handler = (_: unknown, data: { videoPath: string; ratio: number }) => callback(data)
      ipcRenderer.on('proxy:progress', handler)
      return () => {
        ipcRenderer.removeListener('proxy:progress', handler)
      }
    },
    delete: (videoPath: string) => ipcRenderer.invoke('proxy:delete', videoPath)
  },
  project: {
    showSaveDialog: (defaultName?: string) => ipcRenderer.invoke('project:showSaveDialog', defaultName),
    showOpenDialog: () => ipcRenderer.invoke('project:showOpenDialog'),
    save: (filePath: string, content: string) => ipcRenderer.invoke('project:save', filePath, content),
    load: (filePath: string) => ipcRenderer.invoke('project:load', filePath)
  },
  projects: {
    save: (project: unknown) => ipcRenderer.invoke('projects:save', project),
    load: (id: string) => ipcRenderer.invoke('projects:load', id),
    list: () => ipcRenderer.invoke('projects:list'),
    remove: (id: string) => ipcRenderer.invoke('projects:remove', id),
    /** 關閉視窗時用：阻塞到 main 已把專案寫入磁碟（同時記下 lastProjectId）。 */
    flushSync: (project: unknown): boolean => ipcRenderer.sendSync('projects:flushSync', project) === true,
    /** main 在關閉視窗前要求立即 flush。 */
    onFlushRequest: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('projects:flushRequest', handler)
      return () => {
        ipcRenderer.removeListener('projects:flushRequest', handler)
      }
    },
    /** 通知 main：flush 完成，可以關閉視窗。 */
    flushDone: () => ipcRenderer.send('projects:flushDone')
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (partial: unknown) => ipcRenderer.invoke('settings:set', partial),
    onChanged: (callback: (settings: unknown) => void) => {
      const handler = (_: unknown, data: unknown) => callback(data)
      ipcRenderer.on('settings:changed', handler)
      return () => {
        ipcRenderer.removeListener('settings:changed', handler)
      }
    }
  },
  export: {
    detectEncoders: () => ipcRenderer.invoke('export:detectEncoders'),
    selectOutDir: () => ipcRenderer.invoke('export:selectOutDir'),
    openh264Status: () => ipcRenderer.invoke('export:openh264Status'),
    downloadOpenH264: () => ipcRenderer.invoke('export:downloadOpenH264'),
    run: (opts: unknown) => ipcRenderer.invoke('export:run', opts),
    onProgress: (callback: (data: unknown) => void) => {
      const handler = (_: unknown, data: unknown) => callback(data)
      ipcRenderer.on('export:progress', handler)
      return () => {
        ipcRenderer.removeListener('export:progress', handler)
      }
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.api = api
}
