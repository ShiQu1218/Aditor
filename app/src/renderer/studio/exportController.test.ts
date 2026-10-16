import { describe, expect, test, vi } from 'vitest'
import { createExportController, ExportApi, ExportItem } from './exportController'

const ITEMS: ExportItem[] = [
  { id: '1', source: 'D:/v/a.mp4', start: 0, end: 10 },
  { id: '2', source: 'D:/v/a.mp4', start: 20, end: 30 }
]

interface Fake {
  api: ExportApi
  calls: Array<[string, unknown?]>
  progress: Set<(d: unknown) => void>
  h264Progress: Set<(r: number) => void>
  resolveStart: (r: unknown) => void
}

function fake(over: Partial<Record<keyof ExportApi, unknown>> = {}): Fake {
  const calls: Array<[string, unknown?]> = []
  const progress = new Set<(d: unknown) => void>()
  const h264Progress = new Set<(r: number) => void>()
  let resolveStart: (r: unknown) => void = () => undefined
  const api = {
    detectEncoders: async () => {
      calls.push(['detectEncoders'])
      return ['h264_nvenc']
    },
    openh264Status: async () => {
      calls.push(['openh264Status'])
      return { installed: false }
    },
    downloadOpenH264: async () => {
      calls.push(['downloadOpenH264'])
      return 'C:/codecs/openh264.dll'
    },
    selectOutDir: async () => 'D:/out2',
    checkOutDir: async (dir: string) => {
      calls.push(['checkOutDir', dir])
      return { ok: true }
    },
    diskSpace: async (dir: string) => {
      calls.push(['diskSpace', dir])
      return { freeBytes: 10 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 }
    },
    start: (opts: unknown) => {
      calls.push(['start', opts])
      return new Promise((r) => (resolveStart = r))
    },
    cancel: async () => {
      calls.push(['cancel'])
      return { cancelled: true }
    },
    onProgress: (cb: (d: unknown) => void) => {
      progress.add(cb)
      return () => progress.delete(cb)
    },
    onOpenH264Progress: (cb: (r: number) => void) => {
      h264Progress.add(cb)
      return () => h264Progress.delete(cb)
    },
    ...over
  } as unknown as ExportApi
  return { api, calls, progress, h264Progress, resolveStart: (r) => resolveStart(r) }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('exportController wiring', () => {
  test('init detects encoders, openh264 status and disk space of the default dir', async () => {
    const f = fake()
    const c = createExportController(f.api)
    await c.init('D:/out')
    const s = c.getState()
    expect(s.encoders).toEqual(['h264_nvenc'])
    expect(s.openh264Installed).toBe(false)
    expect(s.settings.encoder).toBe('h264_nvenc')
    expect(s.settings.outDir).toBe('D:/out')
    expect(s.disk?.freeBytes).toBeGreaterThan(0)
    expect(f.calls.map((x) => x[0])).toEqual(expect.arrayContaining(['detectEncoders', 'openh264Status', 'diskSpace']))
  })

  test('missing/invalid output dir becomes outDirError (diskSpace rejects), not a thrown error', async () => {
    const f = fake({
      diskSpace: async () => {
        throw new Error('資料夾不存在')
      }
    })
    const c = createExportController(f.api)
    await c.init('D:/gone')
    expect(c.getState().outDirError).toContain('資料夾不存在')
    expect(c.getState().disk).toBeNull()
  })

  test('output dir that is not writable becomes a settings-state blocker before start (checkOutDir), disk space is not queried', async () => {
    const f = fake({ checkOutDir: async () => ({ ok: false, reason: '輸出資料夾無法寫入' }) })
    const c = createExportController(f.api)
    await c.init('D:/readonly')
    expect(c.getState().outDirError).toContain('輸出資料夾無法寫入')
    expect(c.getState().disk).toBeNull()
    expect(f.calls.some((x) => x[0] === 'diskSpace')).toBe(false)
    // 阻擋中不會呼叫 export:start
    await c.start([{ id: 'a', source: 'D:/v.mp4', start: 0, end: 5 }])
    expect(f.calls.some((x) => x[0] === 'start')).toBe(false)
  })

  test('choosing another folder re-checks it and clears the blocker', async () => {
    let ok = false
    const checked: string[] = []
    const f = fake({
      checkOutDir: async (dir: string) => {
        checked.push(dir)
        return ok ? { ok: true } : { ok: false, reason: '輸出資料夾不存在' }
      }
    })
    const c = createExportController(f.api)
    await c.init('D:/gone')
    expect(c.getState().outDirError).toContain('不存在')
    ok = true
    await c.chooseOutDir() // fake selectOutDir -> D:/out2
    expect(c.getState().outDirError).toBeNull()
    expect(c.getState().settings.outDir).toBe('D:/out2')
    expect(checked).toEqual(['D:/gone', 'D:/out2'])
  })

  test('a checkOutDir IPC failure also becomes a blocker rather than an exception', async () => {
    const f = fake({
      checkOutDir: async () => {
        throw new Error('ipc down')
      }
    })
    const c = createExportController(f.api)
    await c.init('D:/x')
    expect(c.getState().outDirError).toContain('ipc down')
  })

  test('null defaultOutDir → outDirError set (must choose a folder)', async () => {
    const c = createExportController(fake().api)
    await c.init(null)
    expect(c.getState().outDirError).toBeTruthy()
  })

  test('start sends export:start payload, subscribes to progress and unsubscribes after finishing', async () => {
    const f = fake()
    const c = createExportController(f.api)
    await c.init('D:/out')
    c.setBaseName('合輯')
    c.setMode('separate')
    const p = c.start(ITEMS)
    await flush()
    expect(c.getState().phase).toBe('running')
    expect(f.progress.size).toBe(1)
    const sent = f.calls.find((x) => x[0] === 'start')![1] as Record<string, unknown>
    expect(sent).toMatchObject({ mode: 'separate', quality: 'copy', outDir: 'D:/out', baseName: '合輯', items: ITEMS })
    ;[...f.progress][0]({ jobIndex: 1, totalJobs: 2, percent: 47, outTimeSeconds: 12.4 })
    expect(c.getState().progress).toMatchObject({ percent: 47, jobIndex: 1, totalJobs: 2 })
    f.resolveStart({ ok: true, outputs: ['D:/out/合輯_1.mp4', 'D:/out/合輯_2.mp4'], notices: ['n'] })
    await p
    expect(c.getState().phase).toBe('done')
    expect(c.getState().result).toMatchObject({ ok: true, cancelled: false, outputs: ['D:/out/合輯_1.mp4', 'D:/out/合輯_2.mp4'] })
    expect(f.progress.size).toBe(0)
  })

  test('precise quality sends the selected encoder', async () => {
    const f = fake()
    const c = createExportController(f.api)
    await c.init('D:/out')
    await c.setQuality('precise')
    void c.start(ITEMS)
    await flush()
    expect(f.calls.find((x) => x[0] === 'start')![1]).toMatchObject({ quality: 'precise', encoder: 'h264_nvenc' })
  })

  test('cancel calls export:cancel and a cancelled result lists completed outputs', async () => {
    const f = fake()
    const c = createExportController(f.api)
    await c.init('D:/out')
    const p = c.start(ITEMS)
    await flush()
    await c.cancel()
    expect(f.calls.some((x) => x[0] === 'cancel')).toBe(true)
    f.resolveStart({ ok: false, cancelled: true, outputs: ['D:/out/a_1.mp4'], notices: [] })
    await p
    const s = c.getState()
    expect(s.phase).toBe('done')
    expect(s.result).toMatchObject({ cancelled: true, outputs: ['D:/out/a_1.mp4'] })
    expect(f.progress.size).toBe(0)
  })

  test('failure keeps the stderr tail and retry re-sends the same request', async () => {
    const f = fake()
    const c = createExportController(f.api)
    await c.init('D:/out')
    const p = c.start(ITEMS)
    await flush()
    f.resolveStart({ ok: false, error: '匯出失敗 (exit code 1):\nConversion failed!', outputs: [] })
    await p
    expect(c.getState().phase).toBe('failed')
    expect(c.getState().result?.error).toContain('Conversion failed!')
    const before = f.calls.filter((x) => x[0] === 'start').length
    void c.retry()
    await flush()
    expect(f.calls.filter((x) => x[0] === 'start').length).toBe(before + 1)
    expect(c.getState().phase).toBe('running')
  })

  test('a thrown IPC error becomes a failed state (no alert, no unhandled rejection)', async () => {
    const f = fake({
      start: async () => {
        throw new Error('ipc broke')
      }
    })
    const c = createExportController(f.api)
    await c.init('D:/out')
    await c.start(ITEMS)
    expect(c.getState().phase).toBe('failed')
    expect(c.getState().result?.error).toContain('ipc broke')
    expect(f.progress.size).toBe(0)
  })

  test('second start while running is ignored', async () => {
    const f = fake()
    const c = createExportController(f.api)
    await c.init('D:/out')
    void c.start(ITEMS)
    await flush()
    void c.start(ITEMS)
    await flush()
    expect(f.calls.filter((x) => x[0] === 'start').length).toBe(1)
  })

  test('done → finish() returns to settings', async () => {
    const f = fake()
    const c = createExportController(f.api)
    await c.init('D:/out')
    const p = c.start(ITEMS)
    await flush()
    f.resolveStart({ ok: true, outputs: ['x'], notices: [] })
    await p
    c.finish()
    expect(c.getState().phase).toBe('settings')
    expect(c.getState().result).toBeNull()
  })

  test('dispose unsubscribes progress listeners and can cancel a running export', async () => {
    const f = fake()
    const c = createExportController(f.api)
    await c.init('D:/out')
    void c.start(ITEMS)
    await flush()
    expect(f.progress.size).toBe(1)
    c.dispose({ cancelIfRunning: true })
    expect(f.progress.size).toBe(0)
    expect(f.calls.some((x) => x[0] === 'cancel')).toBe(true)
  })
})

describe('exportController OpenH264 consent', () => {
  const noHw = { detectEncoders: async () => [] as string[] }

  test('choosing precise with no encoder and openh264 missing opens consent and does NOT download', async () => {
    const f = fake(noHw)
    const c = createExportController(f.api)
    await c.init('D:/out')
    await c.setQuality('precise')
    expect(c.getState().h264.step).toBe('consent')
    expect(f.calls.some((x) => x[0] === 'downloadOpenH264')).toBe(false)
  })

  test('declining consent falls back to copy and never downloads', async () => {
    const f = fake(noHw)
    const c = createExportController(f.api)
    await c.init('D:/out')
    await c.setQuality('precise')
    c.declineConsent()
    expect(c.getState().h264.step).toBe('idle')
    expect(c.getState().settings.quality).toBe('copy')
    expect(f.calls.some((x) => x[0] === 'downloadOpenH264')).toBe(false)
  })

  test('accepting consent downloads with progress, subscribes/unsubscribes, then re-detects', async () => {
    let installed = false
    let encoders: string[] = []
    const f: Fake = fake({
      detectEncoders: async () => encoders,
      openh264Status: async () => ({ installed }),
      downloadOpenH264: async () => {
        f.calls.push(['downloadOpenH264'])
        expect(f.h264Progress.size).toBe(1)
        ;[...f.h264Progress][0](0.5)
        installed = true
        encoders = ['libopenh264']
        return 'C:/codecs/openh264.dll'
      }
    })
    const c = createExportController(f.api)
    await c.init('D:/out')
    await c.setQuality('precise')
    await c.acceptConsent()
    expect(f.calls.filter((x) => x[0] === 'downloadOpenH264').length).toBe(1)
    const s = c.getState()
    expect(s.h264.step).toBe('idle')
    expect(s.openh264Installed).toBe(true)
    expect(s.settings.encoder).toBe('libopenh264')
    expect(s.settings.quality).toBe('precise')
    expect(f.h264Progress.size).toBe(0)
  })

  test('download failure shows an in-page error (step=error), quality falls back to copy', async () => {
    const f = fake({
      ...noHw,
      downloadOpenH264: async () => {
        throw new Error('網路中斷')
      }
    })
    const c = createExportController(f.api)
    await c.init('D:/out')
    await c.setQuality('precise')
    await c.acceptConsent()
    expect(c.getState().h264.step).toBe('error')
    expect(c.getState().h264.error).toContain('網路中斷')
    expect(f.h264Progress.size).toBe(0)
  })

  test('hardware encoder present → no consent', async () => {
    const f = fake()
    const c = createExportController(f.api)
    await c.init('D:/out')
    await c.setQuality('precise')
    expect(c.getState().h264.step).toBe('idle')
  })
})

describe('exportController misc', () => {
  test('chooseOutDir uses selectOutDir, then re-checks disk space', async () => {
    const f = fake()
    const c = createExportController(f.api)
    await c.init('D:/out')
    await c.chooseOutDir()
    expect(c.getState().settings.outDir).toBe('D:/out2')
    expect(f.calls.filter((x) => x[0] === 'diskSpace').map((x) => x[1])).toContain('D:/out2')
  })

  test('subscribe notifies and unsubscribes', async () => {
    const c = createExportController(fake().api)
    const fn = vi.fn()
    const off = c.subscribe(fn)
    c.setBaseName('x')
    expect(fn).toHaveBeenCalled()
    off()
    fn.mockClear()
    c.setBaseName('y')
    expect(fn).not.toHaveBeenCalled()
  })
})
