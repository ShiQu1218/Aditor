// 元件測試用的 window.api 假實作（與 preload/index.ts 的形狀一致）。
// 所有方法都是 vi.fn：測試可檢查呼叫，也可用 overrides 逐項取代；on* 訂閱可由 emit 觸發。
import { vi } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings'
import type { LibraryEntry } from '../src/main/library'

type Listener = (payload?: unknown) => void

export interface FakeApiOptions {
  entries?: LibraryEntry[]
  settings?: Partial<Settings>
  /** 其餘欄位的覆寫（淺層合併到各命名空間） */
  overrides?: Record<string, Record<string, unknown>>
}

export function createFakeApi(opts: FakeApiOptions = {}) {
  const listeners = new Map<string, Set<Listener>>()
  const sub = (channel: string) =>
    vi.fn((cb: Listener) => {
      const set = listeners.get(channel) ?? new Set<Listener>()
      set.add(cb)
      listeners.set(channel, set)
      return () => {
        set.delete(cb)
      }
    })
  let settings: Settings = { ...DEFAULT_SETTINGS, ...opts.settings }
  let entries = opts.entries ?? []

  const ns = {
    engine: {
      probe: vi.fn(async () => null),
      analyze: vi.fn(async () => null),
      cancel: vi.fn(async () => true),
      derive: vi.fn(async (a: { events: unknown[] }) => ({ events: a.events })),
      autoclip: vi.fn(async () => ({ clips: [] })),
      onProgress: sub('engine:progress')
    },
    library: {
      getEntries: vi.fn(async () => entries),
      add: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      toggleFavorite: vi.fn(async () => undefined),
      selectFiles: vi.fn(async () => undefined),
      selectFolder: vi.fn(async () => undefined),
      getWatchFolders: vi.fn(async () => []),
      addWatchFolder: vi.fn(async () => undefined),
      removeWatchFolder: vi.fn(async () => undefined),
      fileExists: vi.fn(async () => true),
      getLoadNotice: vi.fn(async () => null),
      computeHl: vi.fn(async () => undefined),
      onUpdated: sub('library:updated')
    },
    queue: {
      enqueue: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      getState: vi.fn(async () => ({ queue: { analyzing: null, queued: [] }, current: null }))
    },
    cache: {
      loadByVideo: vi.fn(async () => null),
      save: vi.fn(async () => true),
      saveSync: vi.fn(() => true)
    },
    proxy: {
      get: vi.fn(async () => null),
      generate: vi.fn(async () => null),
      onProgress: sub('proxy:progress'),
      delete: vi.fn(async () => true),
      usage: vi.fn(async () => ({ count: 0, bytes: 0 }))
    },
    project: {
      showSaveDialog: vi.fn(async () => null),
      showOpenDialog: vi.fn(async () => null),
      save: vi.fn(async () => true),
      load: vi.fn(async () => null)
    },
    projects: {
      save: vi.fn(async () => true),
      list: vi.fn(async () => []),
      remove: vi.fn(async () => true),
      flushSync: vi.fn(() => true),
      onFlushRequest: sub('projects:flushRequest'),
      flushDone: vi.fn(),
      setDirty: vi.fn(),
      onSaveAndCloseRequest: sub('projects:saveAndCloseRequest'),
      saveAndCloseDone: vi.fn()
    },
    settings: {
      get: vi.fn(async () => settings),
      set: vi.fn(async (partial: Partial<Settings>) => {
        settings = { ...settings, ...partial }
        return { settings, persisted: true }
      }),
      onChanged: sub('settings:changed')
    },
    export: {
      detectEncoders: vi.fn(async () => ['libopenh264']),
      selectOutDir: vi.fn(async () => null),
      openFolder: vi.fn(async () => true),
      openh264Status: vi.fn(async () => ({ installed: true })),
      downloadOpenH264: vi.fn(async () => 'ok'),
      start: vi.fn(async () => ({ ok: true, outputs: [], notices: [] })),
      cancel: vi.fn(async () => ({ cancelled: false })),
      diskSpace: vi.fn(async () => ({ freeBytes: 500 * 1024 ** 3, totalBytes: 1000 * 1024 ** 3 })),
      checkOutDir: vi.fn(async () => ({ ok: true })),
      onProgress: sub('export:progress'),
      onOpenH264Progress: sub('export:openh264Progress')
    }
  }
  for (const [name, patch] of Object.entries(opts.overrides ?? {})) {
    Object.assign((ns as Record<string, Record<string, unknown>>)[name] ?? {}, patch)
  }

  return {
    api: ns,
    /** 觸發某個頻道的訂閱者（例如 library:updated） */
    emit(channel: string, payload?: unknown): void {
      for (const cb of [...(listeners.get(channel) ?? [])]) cb(payload)
    },
    setEntries(next: LibraryEntry[]): void {
      entries = next
    },
    getSettings: () => settings
  }
}

export type FakeApi = ReturnType<typeof createFakeApi>

/** 把假 api 掛到 window（回傳還原函式）。 */
export function installFakeApi(fake: FakeApi): () => void {
  const w = window as unknown as { api?: unknown }
  const prev = w.api
  w.api = fake.api
  return () => {
    w.api = prev
  }
}
