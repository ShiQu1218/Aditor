import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { RECORDING_CHANNELS, type LiveState, type LiveUpdate, type RecordingStatus, type RecorderCapabilities } from '../shared/recording'
import { UPDATE_CHANNELS, type UpdateStatus } from '../shared/update'

type FlushResult = void | boolean | PromiseLike<unknown>
const flushCallbacks = new Set<() => FlushResult>()
const flushRequestHandler = (): void => {
  let ok = true
  for (const callback of [...flushCallbacks]) {
    try {
      const result = callback()
      const thenable = result && typeof (result as PromiseLike<unknown>).then === 'function'
      if (result === false || thenable) {
        ok = false
        if (thenable) void Promise.resolve(result as PromiseLike<unknown>).catch(() => undefined)
      }
    } catch {
      ok = false
    }
  }
  ipcRenderer.send('projects:flushDone', ok)
}

const api = {
  telemetry: { enabled: (): Promise<boolean> => ipcRenderer.invoke('telemetry:enabled') },
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
    /** File.path was removed; preload resolves the local path of a dropped file, then uses the existing import flow. */
    addDroppedFiles: (files: File[]) => {
      const paths = files.map((file) => webUtils.getPathForFile(file)).filter(Boolean)
      return paths.length > 0 ? ipcRenderer.invoke('library:add', paths) : Promise.resolve([])
    },
    remove: (path: string, opts?: { deleteSource?: boolean }) => ipcRenderer.invoke('library:remove', path, opts),
    removeMany: (paths: string[], opts?: { deleteSource?: boolean }) => ipcRenderer.invoke('library:removeMany', paths, opts),
    toggleFavorite: (path: string) => ipcRenderer.invoke('library:toggleFavorite', path),
    setGame: (path: string, game: string) => ipcRenderer.invoke('library:setGame', path, game),
    selectFiles: () => ipcRenderer.invoke('library:selectFiles'),
    selectFolder: () => ipcRenderer.invoke('library:selectFolder'),
    getWatchFolders: () => ipcRenderer.invoke('library:getWatchFolders'),
    addWatchFolder: () => ipcRenderer.invoke('library:addWatchFolder'),
    removeWatchFolder: (dir: string) => ipcRenderer.invoke('library:removeWatchFolder', dir),
    fileExists: (path: string) => ipcRenderer.invoke('library:fileExists', path),
    /** Backup path when the library file is corrupt (null otherwise). */
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
    enqueue: (path: string, force?: boolean) => ipcRenderer.invoke('queue:enqueue', path, force),
    cancel: (path: string) => ipcRenderer.invoke('queue:cancel', path),
    /** Actual queue state (analyzing/queued/progress/start time). */
    getState: () => ipcRenderer.invoke('queue:getState')
  },
  cache: {
    loadByVideo: (videoPath: string) => ipcRenderer.invoke('cache:loadByVideo', videoPath),
    save: (doc: unknown) => ipcRenderer.invoke('cache:save', doc),
    /** Used when leaving Studio/closing the window: blocks until main writes the cache to disk. */
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
    /** Pass a list of video paths and return proxy count and total bytes (used to show disk usage in Settings). */
    usage: (videoPaths: string[]) => ipcRenderer.invoke('proxy:usage', videoPaths)
  },
  projects: {
    save: (project: unknown) => ipcRenderer.invoke('projects:save', project),
    load: (id: string) => ipcRenderer.invoke('projects:load', id),
    list: () => ipcRenderer.invoke('projects:list'),
    /** Most recent project read/write error (kind: save/corrupt/transient/unsupported); null when none. */
    lastError: () => ipcRenderer.invoke('projects:lastError'),
    remove: (id: string) => ipcRenderer.invoke('projects:remove', id),
    /** Used when closing the window: block until main writes the project to disk (and records lastProjectId). */
    flushSync: (project: unknown): boolean => ipcRenderer.sendSync('projects:flushSync', project) === true,
    /** Main requests an immediate flush before closing the window. */
    onFlushRequest: (callback: () => FlushResult) => {
      flushCallbacks.add(callback)
      if (flushCallbacks.size === 1) ipcRenderer.on('projects:flushRequest', flushRequestHandler)
      return () => {
        flushCallbacks.delete(callback)
        if (flushCallbacks.size === 0) ipcRenderer.removeListener('projects:flushRequest', flushRequestHandler)
      }
    },
    /** Notify main that flush is complete and the window can close. */
    flushDone: (ok = true) => ipcRenderer.send('projects:flushDone', ok)
  },
  app: {
    /** Open the third-party notices bundled with the installer. */
    openLicenses: () => ipcRenderer.invoke('app:openLicenses'),
    /** Notified when main minimizes the window to the tray or taskbar. */
    onWindowHidden: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('app:windowHidden', handler)
      return () => {
        ipcRenderer.removeListener('app:windowHidden', handler)
      }
    }
  },
  update: {
    getStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke(UPDATE_CHANNELS.getStatus),
    check: (): Promise<UpdateStatus> => ipcRenderer.invoke(UPDATE_CHANNELS.check),
    /** Explicitly download the available update; checks never download automatically. */
    download: (): Promise<boolean> => ipcRenderer.invoke(UPDATE_CHANNELS.download),
    /** Explicitly install the downloaded update; the quit guard starts the installer after finalization. */
    install: (): Promise<boolean> => ipcRenderer.invoke(UPDATE_CHANNELS.install),
    /** Open GitHub Releases in a browser (manual download for portable builds). */
    openReleases: (): Promise<boolean> => ipcRenderer.invoke(UPDATE_CHANNELS.openReleases),
    onStatus: (callback: (status: UpdateStatus) => void): (() => void) => {
      const handler = (_: unknown, status: UpdateStatus) => callback(status)
      ipcRenderer.on(UPDATE_CHANNELS.status, handler)
      return () => ipcRenderer.removeListener(UPDATE_CHANNELS.status, handler)
    }
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (partial: unknown) => ipcRenderer.invoke('settings:set', partial),
    /** Suggested storage root (shown in first-run setup and Settings). */
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
    /** Cancel an active export (terminate ffmpeg and descendants and remove incomplete output). */
    cancel: () => ipcRenderer.invoke('export:cancel'),
    diskSpace: (dir: string) => ipcRenderer.invoke('export:diskSpace', dir),
    /** Check the output directory before starting (exists, is a directory, and is writable); returns { ok } or { ok:false, reason }. */
    checkOutDir: (dir: string) => ipcRenderer.invoke('export:checkOutDir', dir),
    onProgress: (callback: (data: unknown) => void) => {
      const handler = (_: unknown, data: unknown) => callback(data)
      ipcRenderer.on('export:progress', handler)
      return () => {
        ipcRenderer.removeListener('export:progress', handler)
      }
    },
    /** OpenH264 download progress (0–1). */
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
