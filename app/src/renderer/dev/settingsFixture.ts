/** 僅開發模式（App 以 import.meta.env.DEV 動態載入）：?fixture=settings 的假 window.api，供截圖與版面檢查。 */
import { DEFAULT_SETTINGS, type Settings } from '../../shared/settings'

export function installSettingsFixtureApi(failWrites: boolean): void {
  const GB = 1024 ** 3
  let current: Settings = { ...DEFAULT_SETTINGS, defaultOutDir: 'D:\\Videos\\Apex', lowPerfMode: false }
  const listeners = new Set<(s: Settings) => void>()
  let dirs = ['D:\\Outplayed\\Apex Legends', 'E:\\Captures\\Apex']
  const w = window as unknown as { api?: Record<string, unknown> }
  w.api = {
    ...(w.api ?? {}),
    settings: {
      get: async () => current,
      suggestStorageRoot: async () => 'D:\\Videos\\Aditor',
      set: async (partial: Partial<Settings>) => {
        current = { ...current, ...partial }
        listeners.forEach((l) => l(current))
        return { settings: current, persisted: !failWrites }
      },
      onChanged: (cb: (s: Settings) => void) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      }
    },
    library: {
      getEntries: async () => [{ path: 'D:/a.mp4' }, { path: 'D:/b.mp4' }, { path: 'D:/c.mp4' }],
      getWatchFolders: async () => ({ dirs, missing: [] }),
      addWatchFolder: async () => ({ ok: false, canceled: true, dirs, missing: [] }),
      removeWatchFolder: async (d: string) => {
        dirs = dirs.filter((x) => x !== d)
        return { ok: true, dirs, missing: [] }
      }
    },
    proxy: { usage: async () => ({ count: 3, bytes: 2.4 * GB }), delete: async () => true },
    export: {
      detectEncoders: async () => ['h264_nvenc'],
      selectOutDir: async () => 'D:\\Videos\\Apex',
      openh264Status: async () => ({ installed: true })
    }
  }
}
