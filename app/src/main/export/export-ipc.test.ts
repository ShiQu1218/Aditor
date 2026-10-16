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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'apexhl-ipc-'))
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

// 假 ipcMain / 假 webContents：只模擬 handle 與 send
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

describe('IPC 接線（假 ipcMain / webContents）', () => {
  it('註冊 export:start / export:cancel / export:diskSpace', () => {
    const { handlers } = setup()
    for (const ch of ['export:start', 'export:cancel', 'export:diskSpace']) expect(handlers.has(ch)).toBe(true)
  })

  it('export:start 成功：進度只送給發出請求的 sender（export:progress），輸出在 outDir', async () => {
    const { invoke, sender } = setup()
    const res = await invoke('export:start', sender, req())
    expect(res).toMatchObject({ ok: true, outputs: [path.join(outDir, 'clip_1.mp4')] })
    const progress = sender.sent.filter((m) => m.channel === 'export:progress')
    expect(progress.length).toBeGreaterThan(0)
    expect(progress[0].data).toMatchObject({ jobIndex: 0, totalJobs: 1 })
    expect(typeof progress[0].data.percent).toBe('number')
    expect(fs.readdirSync(outDir)).toEqual(['clip_1.mp4'])
  })

  it('視窗已銷毀就不送進度，也不丟錯', async () => {
    const { invoke, sender } = setup()
    sender.destroyed = true
    const res = await invoke('export:start', sender, req())
    expect(res.ok).toBe(true)
    expect(sender.sent).toEqual([])
  })

  it('export:cancel 中止進行中的匯出：ffmpeg 與孫程序都被殺，partial 檔刪除；再取消一次是 no-op', async () => {
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
    expect(fs.readdirSync(outDir)).toEqual([])
  }, 15000)

  it('沒有進行中的匯出時 export:cancel 是 no-op', async () => {
    const { invoke, sender } = setup()
    expect(await invoke('export:cancel', sender)).toEqual({ cancelled: false })
  })

  it('匯出進行中再 export:start → 明確錯誤，不會啟動第二個 ffmpeg', async () => {
    process.env.FAKE_FFMPEG_SLEEP_MS = '60000'
    const { invoke, sender, service } = setup()
    const p = invoke('export:start', sender, req())
    await waitFor(() => fs.readdirSync(pidDir).length === 1)
    const second = await invoke('export:start', sender, req({ baseName: 'other' }))
    expect(second).toMatchObject({ ok: false, code: 'busy' })
    expect(second.error).toMatch(/進行中/)
    await sleep(200)
    expect(fs.readdirSync(pidDir)).toEqual(['clip_1.partial.mp4.pids.json']) // 只有一個 ffmpeg 啟動過
    await service.cancelAndWait()
    expect(await p).toMatchObject({ cancelled: true })
    expect(service.isRunning()).toBe(false)
  }, 15000)

  it('兩個 start 同時（同一 tick）送出，也只有一個會跑', async () => {
    const { invoke, sender } = setup()
    const [a, b] = await Promise.all([invoke('export:start', sender, req()), invoke('export:start', sender, req({ baseName: 'z' }))])
    const oks = [a, b].filter((r) => r.ok)
    expect(oks.length).toBe(1)
    expect([a, b].find((r) => !r.ok)).toMatchObject({ code: 'busy' })
  })

  it('取消後可以再開始新的匯出', async () => {
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

  it('視窗關閉（webContents destroyed）→ 自動取消，ffmpeg 不會變成孤兒', async () => {
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
    expect(fs.readdirSync(outDir)).toEqual([])
  }, 15000)

  it('export:checkOutDir：存在且可寫入 → ok；不存在／是檔案／不合法路徑 → ok:false 並附原因（不丟錯）', async () => {
    const { invoke, sender, handlers } = setup()
    expect(handlers.has('export:checkOutDir')).toBe(true)
    expect(await invoke('export:checkOutDir', sender, outDir)).toEqual({ ok: true })
    // 檢查用的暫存探測檔不留在資料夾裡
    expect(fs.readdirSync(outDir).filter((f) => f.startsWith('.apexhl-write-test'))).toEqual([])
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

  it('export:diskSpace 回傳有限數字；不合法的目錄被拒絕', async () => {
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

describe('export:start 輸入驗證（不信任 renderer）', () => {
  const bad = async (over: Record<string, unknown>, sender = fakeSender()) => {
    const { invoke } = setup()
    const res = await invoke('export:start', sender, req(over))
    expect(res.ok).toBe(false)
    expect(typeof res.error).toBe('string')
    expect(fs.readdirSync(outDir)).toEqual([])
    expect(fs.readdirSync(pidDir)).toEqual([]) // 沒有啟動 ffmpeg
    return res
  }

  it('整份請求不是物件 / items 空 / 非陣列', async () => {
    const { invoke, sender } = setup()
    for (const raw of [null, 'x', 5, undefined]) expect((await invoke('export:start', sender, raw)).ok).toBe(false)
    await bad({ items: [] })
    await bad({ items: 'nope' })
  })

  it('時間必須是有限數字且 end > start >= 0', async () => {
    for (const [s, e] of [[NaN, 5], [0, Infinity], ['0', 5], [5, 5], [6, 5], [-1, 5]] as const) {
      await bad({ items: [{ id: '1', source, start: s, end: e }] })
    }
  })

  it('來源路徑必須是本機絕對影片路徑且存在（拒絕 UNC / 相對 / 不存在）', async () => {
    for (const src of ['\\\\server\\share\\a.mp4', 'a.mp4', path.join(root, 'missing.mp4'), 42]) {
      await bad({ items: [{ id: '1', source: src, start: 0, end: 5 }] })
    }
  })

  it('outDir 必須是存在的本機絕對目錄', async () => {
    for (const d of ['relative', path.join(root, 'nope'), '\\\\server\\share', 42, source, '']) await bad({ outDir: d })
  })

  it('outDir 不可寫入 → 拒絕', async () => {
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
    if (writable) return // Windows 上唯讀目錄屬性不阻擋寫入，這裡無法重現
    await bad({ outDir: dir })
  })

  it('mode / quality / encoder 型別與值檢查', async () => {
    await bad({ mode: 'weird' })
    await bad({ quality: 'ultra' })
    await bad({ quality: 'precise', encoder: '-vf evil' })
    await bad({ quality: 'precise', encoder: 5 })
  })

  it('baseName 不可路徑穿越：輸出一律在 outDir 內', async () => {
    const { invoke, sender } = setup()
    for (const name of ['..\\..\\evil', '../../evil', 'a/b', 'C:\\x\\y', '..', '', '   ', 'con']) {
      const res = await invoke('export:start', sender, req({ baseName: name }))
      expect(res.ok).toBe(true)
      for (const o of res.outputs as string[]) expect(path.dirname(o)).toBe(path.resolve(outDir))
    }
    expect(fs.existsSync(path.join(root, 'evil_1.mp4'))).toBe(false)
    expect(fs.readdirSync(root).sort()).toEqual(['out', 'pids', 'src.mp4'])
  })

  it('baseName 非字串 → 拒絕', async () => {
    await bad({ baseName: 123 })
    await bad({ baseName: { toString: () => 'x' } })
  })
})

describe('sanitizeBaseName', () => {
  it('移除非法字元、結尾點／空白、保留字、限制長度', () => {
    expect(sanitizeBaseName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j')
    expect(sanitizeBaseName('name. ')).toBe('name')
    expect(sanitizeBaseName('..')).toBe('export')
    expect(sanitizeBaseName('')).toBe('export')
    expect(sanitizeBaseName('CON')).toBe('_CON')
    expect(sanitizeBaseName('x'.repeat(500)).length).toBeLessThanOrEqual(100)
    expect(sanitizeBaseName('精華 剪輯')).toBe('精華 剪輯')
  })
})

describe('preload 與 main 的頻道一致', () => {
  it('preload.export.start/cancel/diskSpace/onProgress 使用 main 註冊／傳送的同名頻道', async () => {
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
    // 進度：preload 監聽的頻道 === service 傳送的頻道
    expect(listened).toEqual(['export:progress'])
    const { invoke, sender } = setup()
    await invoke('export:start', sender, req())
    expect(new Set(sender.sent.map((m) => m.channel))).toEqual(new Set(listened))
  })
})
