import { describe, expect, test } from 'vitest'
import { DEFAULT_SETTINGS, type Settings, type SettingsSetResult } from '../../shared/settings'
import { SettingsController, type SettingsApi } from './settingsController'

type SetFn = (partial: Partial<Settings>) => Promise<SettingsSetResult | unknown>

function makeApi(over: { set?: SetFn; initial?: Settings } = {}) {
  let current: Settings = over.initial ?? { ...DEFAULT_SETTINGS }
  const calls: Array<Partial<Settings>> = []
  const listeners = new Set<(s: Settings) => void>()
  const api: SettingsApi = {
    settings: {
      get: async () => current,
      suggestStorageRoot: async () => 'D:/Videos/Apex Highlighter',
      set:
        over.set ??
        (async (partial) => {
          calls.push(partial)
          current = { ...current, ...partial } as Settings
          return { settings: current, persisted: true }
        }),
      onChanged: (cb) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      }
    },
    library: {
      getEntries: async () => [{ path: 'D:/a.mp4' }, { path: 'D:/b.mp4' }],
      getWatchFolders: async () => ({ dirs: ['D:/rec'], missing: [] }),
      addWatchFolder: async () => ({ ok: true, dirs: ['D:/rec', 'E:/new'], missing: [] }),
      removeWatchFolder: async () => ({ ok: true, dirs: [], missing: [] })
    },
    proxy: {
      usage: async () => ({ count: 1, bytes: 2048 }),
      delete: async () => true
    },
    export: {
      detectEncoders: async () => ['h264_nvenc'],
      selectOutDir: async () => 'D:/Videos',
      openh264Status: async () => ({ installed: false })
    }
  }
  return { api, calls, emit: (s: Settings) => listeners.forEach((l) => l(s)), listeners }
}

async function started(over: Parameters<typeof makeApi>[0] = {}) {
  const rig = makeApi(over)
  const c = new SettingsController(rig.api)
  await c.start()
  return { ...rig, c }
}

describe('SettingsController', () => {
  test('start loads settings, watch folders, proxy usage, encoders and OpenH264 state', async () => {
    const { c } = await started()
    const s = c.getState()
    expect(s.settings).toEqual(DEFAULT_SETTINGS)
    expect(s.watch.dirs).toEqual(['D:/rec'])
    expect(s.proxy).toMatchObject({ status: 'ready', count: 1, bytes: 2048 })
    expect(s.encoders).toMatchObject({ status: 'ready', list: ['h264_nvenc'] })
    expect(s.openh264).toBe(false)
    expect(s.saveFailed).toBe(false)
  })

  test('settings:changed events update the state; stop() unsubscribes', async () => {
    const { c, emit, listeners } = await started()
    emit({ ...DEFAULT_SETTINGS, lowPerfMode: true })
    expect(c.getState().settings?.lowPerfMode).toBe(true)
    c.stop()
    expect(listeners.size).toBe(0)
  })

  test('setBool sends only that field and shows the RETURNED settings', async () => {
    const { c, calls } = await started()
    await c.setBool('autoAnalyze', false)
    expect(calls).toEqual([{ autoAnalyze: false }])
    expect(c.getState().settings?.autoAnalyze).toBe(false)
    expect(c.getState().saveFailed).toBe(false)
  })

  test('control state follows the returned settings, not what the user typed', async () => {
    const { c } = await started({
      // 後端忽略此變更（例如被拒絕）：回傳舊值
      set: async () => ({ settings: { ...DEFAULT_SETTINGS }, persisted: true })
    })
    await c.setBool('lowPerfMode', true)
    expect(c.getState().settings?.lowPerfMode).toBe(false)
  })

  test('persisted:false shows the save-failed notice and a later success clears it', async () => {
    let persisted = false
    const { c } = await started({
      set: async (partial) => ({ settings: { ...DEFAULT_SETTINGS, ...partial } as Settings, persisted })
    })
    await c.setBool('lowPerfMode', true)
    expect(c.getState().saveFailed).toBe(true)
    // 畫面狀態仍同步為回傳值
    expect(c.getState().settings?.lowPerfMode).toBe(true)
    persisted = true
    await c.setBool('lowPerfMode', false)
    expect(c.getState().saveFailed).toBe(false)
  })

  test('a rejected set (IPC failure) is reported as save-failed and re-syncs from get()', async () => {
    const { c } = await started({
      set: async () => {
        throw new Error('ipc down')
      }
    })
    await c.setBool('lowPerfMode', true)
    expect(c.getState().saveFailed).toBe(true)
    expect(c.getState().settings?.lowPerfMode).toBe(false)
  })

  test('setNumber clamps before sending (before/after 0..30) and re-syncs from the result', async () => {
    const { c, calls } = await started()
    await c.setNumber('before', 99)
    await c.setNumber('after', -4)
    expect(calls).toEqual([{ before: 30 }, { after: 0 }])
    expect(c.getState().settings).toMatchObject({ before: 30, after: 0 })
  })

  test('setNumber with a non-number sends nothing and notifies subscribers so the field reverts', async () => {
    const { c, calls } = await started()
    let notified = 0
    c.subscribe(() => (notified += 1))
    await c.setNumber('before', Number.NaN)
    expect(calls).toEqual([])
    expect(notified).toBeGreaterThan(0)
  })

  test.each([
    ['n', 0, 1],
    ['n', 11, 10],
    ['gap', 4, 5],
    ['gap', 61, 60],
    ['before', 31, 30],
    ['after', -1, 0],
    ['max_len', 14, 15],
    ['max_len', 301, 300]
  ] as const)('setAutoclip %s=%s is clamped to %s and sent as the full autoclip object', async (key, input, expected) => {
    const { c, calls } = await started()
    await c.setAutoclip(key, input)
    expect(calls).toHaveLength(1)
    expect(calls[0].autoclip).toEqual({ ...DEFAULT_SETTINGS.autoclip, [key]: expected })
    expect(c.getState().settings?.autoclip[key]).toBe(expected)
  })

  test('storageRoot validation error from main is shown on the row and not stored', async () => {
    const { c } = await started({
      set: async () => ({
        settings: { ...DEFAULT_SETTINGS },
        persisted: true,
        errors: { storageRoot: '無法建立或寫入儲存位置' }
      })
    })
    await c.pickStorageRoot()
    expect(c.getState().rowErrors.storageRoot).toBe('無法建立或寫入儲存位置')
    expect(c.getState().settings?.storageRoot).toBeNull()
  })

  test('pickStorageRoot sends only storageRoot, success clears a previous error; cancel changes nothing', async () => {
    const { c, calls, api } = await started()
    await c.pickStorageRoot()
    expect(calls).toEqual([{ storageRoot: 'D:/Videos' }])
    expect(c.getState().rowErrors.storageRoot).toBeUndefined()
    api.export!.selectOutDir = async () => null
    await c.pickStorageRoot()
    expect(calls).toHaveLength(1)
  })

  test('start loads the suggested storage root; it is refreshed after a successful change', async () => {
    const { c, api } = await started()
    expect(c.getState().suggestedStorageRoot).toBe('D:/Videos/Apex Highlighter')
    api.settings.suggestStorageRoot = async () => 'D:/Videos'
    await c.pickStorageRoot()
    expect(c.getState().suggestedStorageRoot).toBe('D:/Videos')
  })

  test('a failing suggestion lookup leaves the suggestion empty without throwing', async () => {
    const rig = makeApi()
    rig.api.settings.suggestStorageRoot = async () => { throw new Error('x') }
    const c = new SettingsController(rig.api)
    await c.start()
    expect(c.getState().suggestedStorageRoot).toBeNull()
  })

  test('openStorageRoot opens the configured root; nothing happens when unset', async () => {
    const opened: string[] = []
    const rig = makeApi({ initial: { ...DEFAULT_SETTINGS, storageRoot: 'D:/Root' } })
    rig.api.export!.openFolder = async (dir) => { opened.push(dir); return true }
    const c = new SettingsController(rig.api)
    await c.start()
    await c.openStorageRoot()
    expect(opened).toEqual(['D:/Root'])
    const unset = await started()
    unset.api.export!.openFolder = async (dir) => { opened.push(dir); return true }
    await unset.c.openStorageRoot()
    expect(opened).toEqual(['D:/Root'])
  })

  test('addWatchFolder uses the library IPC; errors are shown on the row, cancel is silent', async () => {
    const { c, api } = await started()
    await c.addWatchFolder()
    expect(c.getState().watch.dirs).toEqual(['D:/rec', 'E:/new'])
    api.library!.addWatchFolder = async () => ({ ok: false, error: '資料夾不存在：Q:\\', dirs: ['D:/rec'], missing: [] })
    await c.addWatchFolder()
    expect(c.getState().rowErrors.watchFolders).toBe('資料夾不存在：Q:\\')
    api.library!.addWatchFolder = async () => ({ ok: false, canceled: true, dirs: ['D:/rec'], missing: [] })
    await c.addWatchFolder()
    expect(c.getState().rowErrors.watchFolders).toBeUndefined()
  })

  test('removeWatchFolder updates the list from the IPC result', async () => {
    const { c } = await started()
    await c.removeWatchFolder('D:/rec')
    expect(c.getState().watch.dirs).toEqual([])
  })

  test('deleteProxies deletes through proxy.delete for every library entry, then refreshes usage', async () => {
    const { c, api } = await started()
    const deleted: string[] = []
    api.proxy!.delete = async (p: string) => {
      deleted.push(p)
      return p === 'D:/a.mp4'
    }
    api.proxy!.usage = async () => ({ count: 0, bytes: 0 })
    const res = await c.deleteProxies()
    expect(deleted).toEqual(['D:/a.mp4', 'D:/b.mp4'])
    expect(res.deleted).toBe(1)
    expect(c.getState().proxy).toMatchObject({ status: 'ready', count: 0, bytes: 0 })
  })

  test('refreshEncoders re-detects', async () => {
    const { c, api } = await started()
    api.export!.detectEncoders = async () => ['h264_qsv', 'h264_nvenc']
    await c.refreshEncoders()
    expect(c.getState().encoders.list).toEqual(['h264_qsv', 'h264_nvenc'])
  })

  test('missing optional api parts degrade gracefully (no throw)', async () => {
    const c = new SettingsController({ settings: makeApi().api.settings })
    await c.start()
    expect(c.getState().settings).toEqual(DEFAULT_SETTINGS)
    expect(c.getState().proxy.status).toBe('error')
  })

  test('start failing to read settings falls back to defaults and flags loadFailed', async () => {
    const rig = makeApi()
    rig.api.settings.get = async () => {
      throw new Error('nope')
    }
    const c = new SettingsController(rig.api)
    await c.start()
    expect(c.getState().loadFailed).toBe(true)
    expect(c.getState().settings).toEqual(DEFAULT_SETTINGS)
  })

  describe('OpenH264 download from settings', () => {
    function withDownload(over: { fail?: string; installedAfter?: boolean } = {}) {
      const rig = makeApi()
      let installed = false
      let progressCb: ((r: number) => void) | null = null
      let unsubscribed = 0
      rig.api.export!.openh264Status = async () => ({ installed })
      rig.api.export!.downloadOpenH264 = async () => {
        progressCb?.(0.5)
        if (over.fail) throw new Error(over.fail)
        installed = over.installedAfter ?? true
        return 'C:/codecs/openh264.dll'
      }
      rig.api.export!.onOpenH264Progress = (cb) => {
        progressCb = cb
        return () => {
          unsubscribed += 1
        }
      }
      return { ...rig, unsub: () => unsubscribed }
    }

    test('requesting a download asks for consent first and downloads nothing', async () => {
      const { api } = withDownload()
      let called = 0
      const orig = api.export!.downloadOpenH264!
      api.export!.downloadOpenH264 = async () => {
        called += 1
        return orig()
      }
      const c = new SettingsController(api)
      await c.start()
      c.requestOpenH264Download()
      expect(c.getState().openh264Download.step).toBe('consent')
      expect(called).toBe(0)
      c.cancelOpenH264Download()
      expect(c.getState().openh264Download.step).toBe('idle')
    })

    test('confirming downloads, reports progress, refreshes status to installed and unsubscribes', async () => {
      const { api, unsub } = withDownload()
      const c = new SettingsController(api)
      await c.start()
      expect(c.getState().openh264).toBe(false)
      c.requestOpenH264Download()
      await c.confirmOpenH264Download()
      expect(c.getState().openh264).toBe(true)
      expect(c.getState().openh264Download.step).toBe('idle')
      expect(unsub()).toBe(1)
    })

    test('a failed download shows the error and leaves status not installed', async () => {
      const { api, unsub } = withDownload({ fail: 'HTTP 503' })
      const c = new SettingsController(api)
      await c.start()
      c.requestOpenH264Download()
      await c.confirmOpenH264Download()
      expect(c.getState().openh264Download).toMatchObject({ step: 'error', error: 'HTTP 503' })
      expect(c.getState().openh264).toBe(false)
      expect(unsub()).toBe(1)
    })

    test('without a download api the request is ignored', async () => {
      const c = new SettingsController(makeApi().api)
      await c.start()
      c.requestOpenH264Download()
      expect(c.getState().openh264Download.step).toBe('idle')
    })
  })
})
