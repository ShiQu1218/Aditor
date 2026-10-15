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
    onUpdated: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('library:updated', handler)
      return () => {
        ipcRenderer.removeListener('library:updated', handler)
      }
    }
  },
  queue: {
    enqueue: (path: string) => ipcRenderer.invoke('queue:enqueue', path),
    cancel: (path: string) => ipcRenderer.invoke('queue:cancel', path)
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
