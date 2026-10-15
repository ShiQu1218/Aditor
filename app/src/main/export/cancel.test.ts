import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import { runExport } from './run'
import { killTree } from './killTree'
import { estimateOutputBytes } from '../../shared/exportEstimate'
import type { FfmpegJob } from './plan'

const FAKE = path.resolve(__dirname, '../../../test/fake-ffmpeg.mjs')
const ffmpeg = { bin: process.execPath, prefixArgs: [FAKE] }

let outDir: string
let pidDir: string
let tempDir: string
const savedEnv: Record<string, string | undefined> = {}
const ENV_KEYS = [
  'FAKE_FFMPEG_SLEEP_MS',
  'FAKE_FFMPEG_SLEEP_MAP',
  'FAKE_FFMPEG_EXIT',
  'FAKE_FFMPEG_EXIT_MAP',
  'FAKE_FFMPEG_STDERR_BYTES',
  'FAKE_FFMPEG_GRANDCHILD',
  'FAKE_FFMPEG_PID_DIR'
]

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apexhl-out-'))
  pidDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apexhl-pid-'))
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apexhl-tmp-'))
  process.env.FAKE_FFMPEG_PID_DIR = pidDir
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  // 保險：殺掉測試殘留的孫程序
  for (const f of fs.readdirSync(pidDir)) {
    try {
      const { ffmpeg: a, grandchild: b } = JSON.parse(fs.readFileSync(path.join(pidDir, f), 'utf-8'))
      for (const pid of [a, b]) {
        if (pid) {
          try {
            process.kill(pid)
          } catch {}
        }
      }
    } catch {}
  }
  for (const d of [outDir, pidDir, tempDir]) fs.rmSync(d, { recursive: true, force: true })
})

const job = (name: string): FfmpegJob => {
  const output = path.join(outDir, name)
  return { args: ['-i', 'in.mp4', '-y', output], output }
}
const baseOpts = (jobs: FfmpegJob[]) => ({
  jobs,
  totalEstimatedSeconds: 10,
  outDir,
  estimatedBytes: 1,
  ffmpeg,
  tempDir
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
async function readPids(name: string, timeoutMs = 5000): Promise<{ ffmpeg: number; grandchild: number | null }> {
  const f = path.join(pidDir, name.replace(/\.mp4$/, '.partial.mp4') + '.pids.json')
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf-8'))
    } catch {}
    await sleep(25)
  }
  throw new Error('pid file not written: ' + f)
}
const outFiles = () => fs.readdirSync(outDir).sort()

describe('runExport 取消', () => {
  it('cancel terminates ffmpeg and its child within 2s', async () => {
    process.env.FAKE_FFMPEG_SLEEP_MS = '60000'
    process.env.FAKE_FFMPEG_GRANDCHILD = '1'
    const ac = new AbortController()
    const p = runExport(baseOpts([job('a.mp4')]), { signal: ac.signal })
    const pids = await readPids('a.mp4')
    expect(pids.grandchild).toBeTruthy()
    expect(alive(pids.ffmpeg)).toBe(true)
    expect(alive(pids.grandchild!)).toBe(true)
    const t0 = Date.now()
    ac.abort()
    const res = await p
    expect(res).toMatchObject({ ok: false, cancelled: true, outputs: [] })
    // 以真實 PID 驗證：ffmpeg 與孫程序都已不存在
    const deadline = t0 + 2000
    while ((alive(pids.ffmpeg) || alive(pids.grandchild!)) && Date.now() < deadline) await sleep(25)
    expect(alive(pids.ffmpeg)).toBe(false)
    expect(alive(pids.grandchild!)).toBe(false)
    expect(Date.now() - t0).toBeLessThan(2000)
  }, 15000)

  it('partial output file is removed on cancel, completed outputs are kept', async () => {
    process.env.FAKE_FFMPEG_SLEEP_MAP = JSON.stringify({ b_2: 60000 })
    process.env.FAKE_FFMPEG_GRANDCHILD = '1'
    const ac = new AbortController()
    const p = runExport(baseOpts([job('b_1.mp4'), job('b_2.mp4'), job('b_3.mp4')]), { signal: ac.signal })
    await readPids('b_2.mp4')
    // 第 2 個 job 進行中：.partial 檔存在，第 1 個已完成
    expect(outFiles()).toEqual(['b_1.mp4', 'b_2.partial.mp4'])
    ac.abort()
    const res = await p
    expect(res).toMatchObject({ ok: false, cancelled: true, outputs: [path.join(outDir, 'b_1.mp4')] })
    expect(outFiles()).toEqual(['b_1.mp4'])
    expect(fs.readFileSync(path.join(outDir, 'b_1.mp4'), 'utf-8')).toBe('complete-data')
  }, 15000)

  it('cancel before first job starts leaves no files', async () => {
    const ac = new AbortController()
    ac.abort()
    const res = await runExport({ ...baseOpts([job('c.mp4')]), concatListContent: 'file x\n' }, { signal: ac.signal })
    expect(res).toMatchObject({ ok: false, cancelled: true, outputs: [] })
    expect(outFiles()).toEqual([])
    expect(fs.readdirSync(tempDir)).toEqual([])
    expect(fs.readdirSync(pidDir)).toEqual([]) // 從未啟動 ffmpeg
  })

  it('cancel after completion is a no-op', async () => {
    const ac = new AbortController()
    const res = await runExport(baseOpts([job('d.mp4')]), { signal: ac.signal })
    expect(res).toEqual({ ok: true, outputs: [path.join(outDir, 'd.mp4')] })
    ac.abort()
    await sleep(50)
    expect(outFiles()).toEqual(['d.mp4'])
    expect(fs.readFileSync(path.join(outDir, 'd.mp4'), 'utf-8')).toBe('complete-data')
  })

  it('second export can start after a cancelled one', async () => {
    process.env.FAKE_FFMPEG_SLEEP_MS = '60000'
    const ac = new AbortController()
    const p = runExport(baseOpts([job('e.mp4')]), { signal: ac.signal })
    await readPids('e.mp4')
    ac.abort()
    expect(await p).toMatchObject({ cancelled: true })
    process.env.FAKE_FFMPEG_SLEEP_MS = '0'
    const res = await runExport(baseOpts([job('e.mp4')]), { signal: new AbortController().signal })
    expect(res).toEqual({ ok: true, outputs: [path.join(outDir, 'e.mp4')] })
    expect(outFiles()).toEqual(['e.mp4'])
  }, 15000)

  it('failure (non-zero exit) also removes the partial file and surfaces stderr tail', async () => {
    process.env.FAKE_FFMPEG_EXIT = '3'
    process.env.FAKE_FFMPEG_STDERR_BYTES = '10000'
    const res = await runExport(baseOpts([job('f.mp4')]), {})
    expect(res.ok).toBe(false)
    if (res.ok || res.cancelled) throw new Error('expected failure')
    expect(res.error).toContain('exit code 3')
    expect(res.error).toContain('TAIL_MARKER')
    // 只保留最後 4 KB 的 stderr
    expect(res.error.length).toBeLessThan(4096 + 200)
    expect(outFiles()).toEqual([])
  })

  it('failure in a later job keeps earlier finished outputs', async () => {
    process.env.FAKE_FFMPEG_EXIT_MAP = JSON.stringify({ g_2: 1 })
    const res = await runExport(baseOpts([job('g_1.mp4'), job('g_2.mp4')]), {})
    expect(res).toMatchObject({ ok: false, outputs: [path.join(outDir, 'g_1.mp4')] })
    expect(outFiles()).toEqual(['g_1.mp4'])
  })

  it('reports progress from ffmpeg -progress output', async () => {
    const seen: number[] = []
    await runExport(baseOpts([job('h.mp4')]), { onProgress: (p) => seen.push(p.outTimeSeconds) })
    expect(seen).toContain(1)
    expect(seen).toContain(2)
  })
})

describe('killTree', () => {
  it('tolerates an already-exited process', async () => {
    const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' })
    await new Promise((r) => child.on('close', r))
    await expect(killTree(child)).resolves.toBeUndefined()
  })

  it('kills a real process and its grandchild', async () => {
    const child = spawn(
      process.execPath,
      ['-e', "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setInterval(()=>{},1000)"],
      { stdio: 'ignore', detached: process.platform !== 'win32' }
    )
    await sleep(500)
    const closed = new Promise((r) => child.on('close', r))
    await killTree(child)
    await closed
    expect(alive(child.pid!)).toBe(false)
  })

  it('falls back to child.kill when taskkill cannot be spawned', async () => {
    const calls: string[] = []
    const fakeChild = Object.assign(new EventEmitter(), {
      pid: 4242,
      exitCode: null,
      signalCode: null,
      kill: (sig?: string) => {
        calls.push('kill:' + sig)
        return true
      }
    })
    const spawnImpl = ((cmd: string, args: string[]) => {
      calls.push('spawn:' + cmd + ' ' + args.join(' '))
      const ee = new EventEmitter()
      setImmediate(() => ee.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' })))
      return ee
    }) as never
    await killTree(fakeChild as never, { platform: 'win32', spawnImpl })
    // argv 陣列（不經 shell 字串）
    expect(calls[0]).toBe('spawn:taskkill /pid 4242 /T /F')
    expect(calls).toContain('kill:SIGKILL')
  })

  it('uses process.kill(-pid) on non-Windows', async () => {
    const calls: Array<[number, string | number | undefined]> = []
    const fakeChild = Object.assign(new EventEmitter(), { pid: 777, exitCode: null, signalCode: null, kill: () => true })
    await killTree(fakeChild as never, {
      platform: 'linux',
      killImpl: ((pid: number, sig?: string) => {
        calls.push([pid, sig])
        return true
      }) as never
    })
    expect(calls).toEqual([[-777, 'SIGKILL']])
  })
})

describe('estimateOutputBytes (shared)', () => {
  const proj = (secs: number) => ({ items: [{ id: 'x', source: 'a.mp4', start: 0, end: secs }] })
  it('estimateOutputBytes grows with duration and differs for copy vs precise', () => {
    expect(estimateOutputBytes(proj(120), 'precise')).toBeGreaterThan(estimateOutputBytes(proj(60), 'precise'))
    expect(estimateOutputBytes(proj(60), 'copy')).not.toBe(estimateOutputBytes(proj(60), 'precise'))
    expect(estimateOutputBytes(proj(0), 'copy')).toBe(0)
    expect(estimateOutputBytes({ items: [] }, 'copy')).toBe(0)
  })
})
