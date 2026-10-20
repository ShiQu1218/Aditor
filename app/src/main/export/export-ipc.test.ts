import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import { createExportService, registerExportHandlers, sanitizeBaseName } from './export-ipc'

const FAKE = path.resolve(__dirname, '../../../test/fake-ffmpeg.mjs')

let root: string
let outDir: string
let pidDir: string
let source: string
const ENV_KEYS = ['FAKE_FFMPEG_SLEEP_MS', 'FAKE_FFMPEG_SLEEP_MAP', 'FAKE_FFMPEG_EXIT', 'FAKE_FFMPEG_GRANDCHILD', 'FAKE_FFMPEG_PID_DIR']
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-ipc-'))
  outDir = path.join(root, 'out')
  pidDir = path.join(root, 'pids')
  fs.mkdirSync(outDir)
  fs.mkdirSync(pidDir)
  source = path.join(root, 'src.mp4')
  fs.writeFileSync(source, 'x')
  process.env.FAKE_FFMPEG_PID_DIR = pidDir
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  for (const f of fs.readdirSync(pidDir)) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(pidDir, f), 'utf-8'))
      for (const pid of [j.ffmpeg, j.grandchild]) if (pid) try { process.kill(pid) } catch {}
    } catch {}
  }
  fs.rmSync(root, { recursive: true, force: true })
})

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout')
    await sleep(25)
  }
}

// Fake ipcMain/webContents: simulate only handle and send.
function fakeIpc() {
  const handlers = new Map<string, (event: any, ...args: any[]) => unknown>()
  return {
    handlers,
    ipcMain: { handle: (ch: string, fn: (event: any, ...args: any[]) => unknown) => void handlers.set(ch, fn) },
    invoke: (ch: string, sender: unknown, ...args: unknown[]) => {
      const h = handlers.get(ch)
      if (!h) throw new Error('no handler for ' + ch)
      return Promise.resolve(h({ sender }, ...args)) as Promise<any>
    }
  }
}
function fakeSender() {
  const ee = new EventEmitter()
  const sent: Array<{ channel: string; data: any }> = []
  return Object.assign(ee, {
    sent,
    destroyed: false,
    isDestroyed() {
      return this.destroyed
    },
    send(channel: string, data: unknown) {
      sent.push({ channel, data })
    }
  })
}
function setup() {
  const service = createExportService({ ffmpeg: { bin: process.execPath, prefixArgs: [FAKE] }, tempDir: path.join(root, 'tmp') })
  const ipc = fakeIpc()
  registerExportHandlers(ipc.ipcMain, service)
  return { service, ...ipc, sender: fakeSender() }
}
const req = (over: Record<string, unknown> = {}) => ({
  items: [{ id: '1', source, start: 0, end: 5 }],
  mode: 'separate',
  quality: 'copy',
  outDir,
  baseName: 'clip',
  ...over
})

describe('IPC wiring (fake ipcMain/webContents)', () => {
  it('registers export:start / export:cancel / export:diskSpace', () => {
    const { handlers } = setup()
    for (const ch of ['export:start', 'export:cancel', 'export:diskSpace']) expect(handlers.has(ch)).toBe(true)
  })

  it('export:start succeeds: progress is sent only to the requesting sender (export:progress), with output in outDir/Clips', async () => {
    const { invoke, sender } = setup()
    const res = await invoke('export:start', sender, req())
    expect(res).toMatchObject({ ok: true, outputs: [path.join(outDir, 'Clips', 'clip_1.mp4')] })
    const progress = sender.sent.filter((m) => m.channel === 'export:progress')
    expect(progress.length).toBeGreaterThan(0)
    expect(progress[0].data).toMatchObject({ jobIndex: 0, totalJobs: 1 })
    expect(typeof progress[0].data.percent).toBe('number')
    expect(fs.readdirSync(outDir)).toEqual(['Clips'])
    expect(fs.readdirSync(path.join(outDir, 'Clips'))).toEqual(['clip_1.mp4'])
  })

  it('mode=concat: actual output directory is outDir/Merged (created automatically), outputs are inside it, and Clips is not created', async () => {
    const { invoke, sender } = setup()
    expect(fs.readdirSync(outDir)).toEqual([])
    const res = await invoke('export:start', sender, req({ mode: 'concat', baseName: 'joined' }))
    expect(res).toMatchObject({ ok: true, outputs: [path.join(outDir, 'Merged', 'joined.mp4')] })
    expect(fs.readdirSync(outDir)).toEqual(['Merged'])
    expect(fs.readdirSync(path.join(outDir, 'Merged'))).toEqual(['joined.mp4'])
  })

  it('mode=separate: actual output directory is outDir/Clips; reuse it when it already exists', async () => {
    const { invoke, sender } = setup()
    fs.mkdirSync(path.join(outDir, 'Clips'))
    const res = await invoke('export:start', sender, req())
    expect(res).toMatchObject({ ok: true, outputs: [path.join(outDir, 'Clips', 'clip_1.mp4')] })
    expect(fs.existsSync(path.join(outDir, 'Merged'))).toBe(false)
  })

  it('checks duplicate names only within the subdirectory: a same-named file in outDir is not a conflict, but one in Clips is renamed', async () => {
    const { invoke, sender } = setup()
    fs.writeFileSync(path.join(outDir, 'clip_1.mp4'), 'root-file')
    const r1 = await invoke('export:start', sender, req())
    expect(r1).toMatchObject({ ok: true, outputs: [path.join(outDir, 'Clips', 'clip_1.mp4')] })
    const r2 = await invoke('export:start', sender, req())
    expect(r2).toMatchObject({ ok: true, outputs: [path.join(outDir, 'Clips', 'clip (2)_1.mp4')] })
    expect(fs.readFileSync(path.join(outDir, 'clip_1.mp4'), 'utf-8')).toBe('root-file')
  })

  it('fails with an error and does not start ffmpeg when a file occupies the subdirectory name', async () => {
    const { invoke, sender } = setup()
    fs.writeFileSync(path.join(outDir, 'Clips'), 'i am a file')
    const res = await invoke('export:start', sender, req())
    expect(res.ok).toBe(false)
    expect(typeof res.error).toBe('string')
    expect(fs.readdirSync(pidDir)).toEqual([])
  })

  it('does not send progress or throw after the window is destroyed', async () => {
    const { invoke, sender } = setup()
    sender.destroyed = true
    const res = await invoke('export:start', sender, req())
    expect(res.ok).toBe(true)
    expect(sender.sent).toEqual([])
  })

  it('export:cancel stops the active export: ffmpeg and its grandchild are killed and partial files removed; a second cancel is a no-op', async () => {
    process.env.FAKE_FFMPEG_SLEEP_MS = '60000'
    process.env.FAKE_FFMPEG_GRANDCHILD = '1'
    const { invoke, sender } = setup()
    const p = invoke('export:start', sender, req())
    const pf = path.join(pidDir, 'clip_1.partial.mp4.pids.json')
    await waitFor(() => fs.existsSync(pf))
    const pids = JSON.parse(fs.readFileSync(pf, 'utf-8'))
    const c1 = await invoke('export:cancel', sender)
    const c2 = await invoke('export:cancel', sender)
    expect(c1).toEqual({ cancelled: true })
    expect(c2).toEqual({ cancelled: false })
    const res = await p
    expect(res).toMatchObject({ ok: false, cancelled: true, outputs: [] })
    await waitFor(() => !alive(pids.ffmpeg) && !alive(pids.grandchild), 2000)
    expect(fs.readdirSync(path.join(outDir, 'Clips'))).toEqual([])
  }, 15000)

  it('export:cancel is a no-op when no export is active', async () => {
    const { invoke, sender } = setup()
    expect(await invoke('export:cancel', sender)).toEqual({ cancelled: false })
  })

  it('rejects export:start with a clear error during an export and does not start a second ffmpeg', async () => {
    process.env.FAKE_FFMPEG_SLEEP_MS = '60000'
    const { invoke, sender, service } = setup()
    const p = invoke('export:start', sender, req())
    await waitFor(() => fs.readdirSync(pidDir).length === 1)
    const second = await invoke('export:start', sender, req({ baseName: 'other' }))
    expect(second).toMatchObject({ ok: false, code: 'busy' })
    expect(second.error).toMatch(/進行中/)
    await sleep(200)
    expect(fs.readdirSync(pidDir)).toEqual(['clip_1.partial.mp4.pids.json']) // Only one FFmpeg process was started.
    await service.cancelAndWait()
    expect(await p).toMatchObject({ cancelled: true })
    expect(service.isRunning()).toBe(false)
  }, 15000)

  it('runs only one of two start requests sent in the same tick', async () => {
    const { invoke, sender } = setup()
    const [a, b] = await Promise.all([invoke('export:start', sender, req()), invoke('export:start', sender, req({ baseName: 'z' }))])
    const oks = [a, b].filter((r) => r.ok)
    expect(oks.length).toBe(1)
    expect([a, b].find((r) => !r.ok)).toMatchObject({ code: 'busy' })
  })

  it('allows a new export after cancellation', async () => {
    process.env.FAKE_FFMPEG_SLEEP_MS = '60000'
    const { invoke, sender, service } = setup()
    const p = invoke('export:start', sender, req())
    await waitFor(() => fs.readdirSync(pidDir).length === 1)
    await service.cancelAndWait()
    await p
    process.env.FAKE_FFMPEG_SLEEP_MS = '0'
    const res = await invoke('export:start', sender, req())
    expect(res.ok).toBe(true)
  }, 15000)

  it('automatically cancels on window close (webContents destroyed), so ffmpeg is not orphaned', async () => {
    process.env.FAKE_FFMPEG_SLEEP_MS = '60000'
    process.env.FAKE_FFMPEG_GRANDCHILD = '1'
    const { invoke, sender } = setup()
    const p = invoke('export:start', sender, req())
    const pf = path.join(pidDir, 'clip_1.partial.mp4.pids.json')
    await waitFor(() => fs.existsSync(pf))
    const pids = JSON.parse(fs.readFileSync(pf, 'utf-8'))
    sender.emit('destroyed')
    expect(await p).toMatchObject({ ok: false, cancelled: true })
    await waitFor(() => !alive(pids.ffmpeg) && !alive(pids.grandchild), 2000)
    expect(fs.readdirSync(path.join(outDir, 'Clips'))).toEqual([])
  }, 15000)

  it('export:checkOutDir returns ok for existing writable directories; missing paths, files, and invalid paths return ok:false with a reason (without throwing)', async () => {
    const { invoke, sender, handlers } = setup()
    expect(handlers.has('export:checkOutDir')).toBe(true)
    expect(await invoke('export:checkOutDir', sender, outDir)).toEqual({ ok: true })
    // The temporary write-probe file must not remain in the directory.
    expect(fs.readdirSync(outDir).filter((f) => f.startsWith('.aditor-write-test'))).toEqual([])
    const missing = await invoke('export:checkOutDir', sender, path.join(root, 'nope'))
    expect(missing).toMatchObject({ ok: false })
    expect(missing.reason).toContain('不存在')
    const file = await invoke('export:checkOutDir', sender, source)
    expect(file).toMatchObject({ ok: false })
    expect(file.reason).toContain('不是資料夾')
    for (const bad of [42, '', 'relative/dir', '\\server\share', null]) {
      const r = await invoke('export:checkOutDir', sender, bad)
      expect(r).toMatchObject({ ok: false })
      expect(typeof r.reason).toBe('string')
    }
  })

  it('export:diskSpace returns a finite number and rejects invalid directories', async () => {
    const { invoke, sender } = setup()
    const r = await invoke('export:diskSpace', sender, outDir)
    expect(Number.isFinite(r.freeBytes)).toBe(true)
    expect(Number.isFinite(r.totalBytes)).toBe(true)
    expect(r.totalBytes).toBeGreaterThan(0)
    expect(r.freeBytes).toBeLessThanOrEqual(r.totalBytes)
    for (const bad of [42, '', 'relative/dir', path.join(root, 'nope'), '\\\\server\\share', null, source]) {
      await expect(invoke('export:diskSpace', sender, bad)).rejects.toThrow()
    }
  })
})

describe('export:start input validation (renderer is untrusted)', () => {
  const bad = async (over: Record<string, unknown>, sender = fakeSender()) => {
    const { invoke } = setup()
    const res = await invoke('export:start', sender, req(over))
    expect(res.ok).toBe(false)
    expect(typeof res.error).toBe('string')
    expect(fs.readdirSync(outDir)).toEqual([])
    expect(fs.readdirSync(pidDir)).toEqual([]) // FFmpeg was not started.
    return res
  }

  it('rejects a non-object request, empty items, or non-array items', async () => {
    const { invoke, sender } = setup()
    for (const raw of [null, 'x', 5, undefined]) expect((await invoke('export:start', sender, raw)).ok).toBe(false)
    await bad({ items: [] })
    await bad({ items: 'nope' })
  })

  it('requires finite times with end > start >= 0', async () => {
    for (const [s, e] of [[NaN, 5], [0, Infinity], ['0', 5], [5, 5], [6, 5], [-1, 5]] as const) {
      await bad({ items: [{ id: '1', source, start: s, end: e }] })
    }
  })

  it('requires an existing local absolute video path (rejects UNC, relative, and missing paths)', async () => {
    for (const src of ['\\\\server\\share\\a.mp4', 'a.mp4', path.join(root, 'missing.mp4'), 42]) {
      await bad({ items: [{ id: '1', source: src, start: 0, end: 5 }] })
    }
  })

  it('requires outDir to be an existing local absolute directory', async () => {
    for (const d of ['relative', path.join(root, 'nope'), '\\\\server\\share', 42, source, '']) await bad({ outDir: d })
  })

  it('rejects an unwritable outDir', async () => {
    const dir = path.join(root, 'ro')
    fs.mkdirSync(dir)
    fs.chmodSync(dir, 0o555)
    const writable = (() => {
      try {
        fs.writeFileSync(path.join(dir, 'probe'), '')
        fs.rmSync(path.join(dir, 'probe'))
        return true
      } catch {
        return false
      }
    })()
    if (writable) return // Windows read-only directory attributes do not prevent writes, so this cannot be reproduced here.
    await bad({ outDir: dir })
  })

  it('validates mode/quality/encoder types and values', async () => {
    await bad({ mode: 'weird' })
    await bad({ quality: 'ultra' })
    await bad({ quality: 'precise', encoder: '-vf evil' })
    await bad({ quality: 'precise', encoder: 5 })
  })

  it('prevents baseName path traversal so all output stays within outDir', async () => {
    const { invoke, sender } = setup()
    for (const name of ['..\\..\\evil', '../../evil', 'a/b', 'C:\\x\\y', '..', '', '   ', 'con']) {
      const res = await invoke('export:start', sender, req({ baseName: name }))
      expect(res.ok).toBe(true)
      for (const o of res.outputs as string[]) expect(path.dirname(o)).toBe(path.join(path.resolve(outDir), 'Clips'))
    }
    expect(fs.existsSync(path.join(root, 'evil_1.mp4'))).toBe(false)
    expect(fs.readdirSync(root).sort()).toEqual(['out', 'pids', 'src.mp4'])
  })

  it('rejects a non-string baseName', async () => {
    await bad({ baseName: 123 })
    await bad({ baseName: { toString: () => 'x' } })
  })
})

describe('sanitizeBaseName', () => {
  it('removes invalid characters, trailing dots/spaces, and reserved names, and limits length', () => {
    expect(sanitizeBaseName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j')
    expect(sanitizeBaseName('name. ')).toBe('name')
    expect(sanitizeBaseName('..')).toBe('export')
    expect(sanitizeBaseName('')).toBe('export')
    expect(sanitizeBaseName('CON')).toBe('_CON')
    expect(sanitizeBaseName('x'.repeat(500)).length).toBeLessThanOrEqual(100)
    expect(sanitizeBaseName('精華 剪輯')).toBe('精華 剪輯')
  })
})

describe('preload and main channel names match', () => {
  it('preload.export.start/cancel/diskSpace/onProgress use the same channel names registered/sent by main', async () => {
    const invoked: Array<{ channel: string; args: unknown[] }> = []
    const listened: string[] = []
    let exposed: any
    vi.resetModules()
    vi.doMock('electron', () => ({
      contextBridge: { exposeInMainWorld: (_: string, api: unknown) => void (exposed = api) },
      ipcRenderer: {
        invoke: (channel: string, ...args: unknown[]) => void invoked.push({ channel, args }),
        on: (channel: string) => void listened.push(channel),
        removeListener: () => undefined,
        send: () => undefined,
        sendSync: () => undefined
      }
    }))
    Object.defineProperty(process, 'contextIsolated', { value: true, configurable: true })
    await import('../../preload/index')
    const ex = exposed.export
    const payload = req()
    ex.start(payload)
    ex.cancel()
    ex.diskSpace('C:\\x')
    ex.onProgress(() => undefined)
    vi.doUnmock('electron')
    delete (process as unknown as Record<string, unknown>).contextIsolated

    const { handlers } = setup()
    const chans = invoked.map((c) => c.channel)
    expect(chans).toEqual(['export:start', 'export:cancel', 'export:diskSpace'])
    for (const c of chans) expect(handlers.has(c)).toBe(true)
    expect(invoked[0].args).toEqual([payload])
    expect(invoked[2].args).toEqual(['C:\\x'])
    // Progress: the channel listened to by preload matches the one sent by the service.
    expect(listened).toEqual(['export:progress'])
    const { invoke, sender } = setup()
    await invoke('export:start', sender, req())
    expect(new Set(sender.sent.map((m) => m.channel))).toEqual(new Set(listened))
  })
})
