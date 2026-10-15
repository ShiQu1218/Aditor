import { contextBridge, ipcRenderer } from 'electron'

export interface Api {
  engine: {
    probe: (path: string) => Promise<unknown>
    analyze: (args: unknown) => Promise<unknown>
    cancel: (targetId: string) => Promise<unknown>
    derive: (args: unknown) => Promise<unknown>
    autoclip: (args: unknown) => Promise<unknown>
    onProgress: (callback: (data: { t: number; duration: number }) => void) => () => void
  }
}

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
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.api = api
}
