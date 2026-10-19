import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { RECORDING_CHANNELS, type LiveState, type LiveUpdate, type RecordingStatus, type RecorderCapabilities } from '../shared/recording'

const api = {
  recording: {
    testObs: () => ipcRenderer.invoke(RECORDING_CHANNELS.testObs),
    getStatus: (): Promise<RecordingStatus> => ipcRenderer.invoke(RECORDING_CHANNELS.getStatus),
    getCapabilities: (): Promise<RecorderCapabilities | null> => ipcRenderer.invoke(RECORDING_CHANNELS.getCapabilities),
    startManual: (): Promise<boolean> => ipcRenderer.invoke(RECORDING_CHANNELS.startManual),
    stopManual: (): Promise<void> => ipcRenderer.invoke(RECORDING_CHANNELS.stopManual),
    setPaused: (paused: boolean): Promise<void> => ipcRenderer.invoke(RECORDING_CHANNELS.setPaused, paused),
    onStatus: (callback: (status: RecordingStatus) => void): (() => void) => {
      const handler = (_: unknown, status: RecordingStatus) => callback(status)
      ipcRenderer.on(RECORDING_CHANNELS.status, handler)
      return () => ipcRenderer.removeListener(RECORDING_CHANNELS.status, handler)
    },
    getLive: (): Promise<LiveState | null> => ipcRenderer.invoke(RECORDING_CHANNELS.getLive),
    readInit: (sessionId: string): Promise<Uint8Array> => ipcRenderer.invoke(RECORDING_CHANNELS.readInit, sessionId),
    readSegment: (sessionId: string, seq: number): Promise<Uint8Array> =>
      ipcRenderer.invoke(RECORDING_CHANNELS.readSegment, sessionId, seq),
    onLive: (callback: (update: LiveUpdate) => void): (() => void) => {
      const handler = (_: unknown, update: LiveUpdate) => callback(update)
      ipcRenderer.on(RECORDING_CHANNELS.live, handler)
      return () => ipcRenderer.removeListener(RECORDING_CHANNELS.live, handler)
    }
  },
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
    /** File.path 已移除；在 preload 解析拖入檔案的本機路徑，再沿用匯入流程。 */
    addDroppedFiles: (files: File[]) => {
      const paths = files.map((file) => webUtils.getPathForFile(file)).filter(Boolean)
      return paths.length > 0 ? ipcRenderer.invoke('library:add', paths) : Promise.resolve([])
    },
    remove: (path: string) => ipcRenderer.invoke('library:remove', path),
    toggleFavorite: (path: string) => ipcRenderer.invoke('library:toggleFavorite', path),
    selectFiles: () => ipcRenderer.invoke('library:selectFiles'),
    selectFolder: () => ipcRenderer.invoke('library:selectFolder'),
    getWatchFolders: () => ipcRenderer.invoke('library:getWatchFolders'),
    addWatchFolder: () => ipcRenderer.invoke('library:addWatchFolder'),
    removeWatchFolder: (dir: string) => ipcRenderer.invoke('library:removeWatchFolder', dir),
    fileExists: (path: string) => ipcRenderer.invoke('library:fileExists', path),
    /** 影片庫檔案損毀時的備份路徑（否則 null） */
    getLoadNotice: () => ipcRenderer.invoke('library:getLoadNotice'),
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
    loadByVideo: (videoPath: string) => ipcRenderer.invoke('cache:loadByVideo', videoPath),
    save: (doc: unknown) => ipcRenderer.invoke('cache:save', doc),
    /** 離開工作室／關閉視窗時用：阻塞到 main 已把快取寫入磁碟 */
    saveSync: (doc: unknown): boolean => ipcRenderer.sendSync('cache:saveSync', doc) === true
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
    delete: (videoPath: string) => ipcRenderer.invoke('proxy:delete', videoPath),
    /** 傳入影片路徑清單，回傳其代理檔數量與總位元組（設定頁顯示佔用空間） */
    usage: (videoPaths: string[]) => ipcRenderer.invoke('proxy:usage', videoPaths)
  },
  projects: {
    save: (project: unknown) => ipcRenderer.invoke('projects:save', project),
    load: (id: string) => ipcRenderer.invoke('projects:load', id),
    list: () => ipcRenderer.invoke('projects:list'),
    /** 最近一次專案讀寫錯誤（kind: save/corrupt/transient/unsupported）；沒有則 null */
    lastError: () => ipcRenderer.invoke('projects:lastError'),
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
    flushDone: (ok = true) => ipcRenderer.send('projects:flushDone', ok)
  },
  app: {
    /** 開啟隨安裝包附帶的第三方授權清單 */
    openLicenses: () => ipcRenderer.invoke('app:openLicenses')
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (partial: unknown) => ipcRenderer.invoke('settings:set', partial),
    /** 建議的儲存根資料夾（首次啟動引導與設定畫面顯示用） */
    suggestStorageRoot: (): Promise<string> => ipcRenderer.invoke('settings:suggestStorageRoot'),
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
    openFolder: (dir: string) => ipcRenderer.invoke('export:openFolder', dir),
    openh264Status: () => ipcRenderer.invoke('export:openh264Status'),
    downloadOpenH264: () => ipcRenderer.invoke('export:downloadOpenH264'),
    start: (opts: unknown) => ipcRenderer.invoke('export:start', opts),
    /** 中止進行中的匯出（ffmpeg 與子程序一併終止、刪除未完成的輸出） */
    cancel: () => ipcRenderer.invoke('export:cancel'),
    diskSpace: (dir: string) => ipcRenderer.invoke('export:diskSpace', dir),
    /** 開始前檢查輸出資料夾（存在、是資料夾、可寫入）；回傳 { ok } 或 { ok:false, reason } */
    checkOutDir: (dir: string) => ipcRenderer.invoke('export:checkOutDir', dir),
    onProgress: (callback: (data: unknown) => void) => {
      const handler = (_: unknown, data: unknown) => callback(data)
      ipcRenderer.on('export:progress', handler)
      return () => {
        ipcRenderer.removeListener('export:progress', handler)
      }
    },
    /** OpenH264 下載進度（0–1） */
    onOpenH264Progress: (callback: (ratio: number) => void) => {
      const handler = (_: unknown, ratio: number) => callback(ratio)
      ipcRenderer.on('export:openh264Progress', handler)
      return () => {
        ipcRenderer.removeListener('export:openh264Progress', handler)
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
