import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { generateProxy, proxyPath, cancelAllProxies, cleanStaleProxyPartials, orderEncoders } from './proxy'
import { codecsDir, proxyDir } from '../shared/paths'

const FAKE = path.resolve(__dirname, '../../test/fake-proxy-ffmpeg.mjs')
const ffmpeg = { bin: process.execPath, prefixArgs: [FAKE] }

let appData: string
let saved: Record<string, string | undefined> = {}
const KEYS = ['APPDATA', 'FAKE_OK_ENCODERS', 'FAKE_LOG', 'FAKE_SLEEP_MS']

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  appData = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-proxy-'))
  process.env.APPDATA = appData
  process.env.FAKE_LOG = path.join(appData, 'calls.log')
})
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  fs.rmSync(appData, { recursive: true, force: true })
})

const calls = (): Array<{ enc: string; path: string }> =>
  fs.existsSync(process.env.FAKE_LOG!)
    ? fs.readFileSync(process.env.FAKE_LOG!, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    : []

describe('generateProxy encoder selection (C2)', () => {
  it('uses the detected list: only h264_qsv available -> qsv is used, nvenc is never tried', async () => {
    process.env.FAKE_OK_ENCODERS = 'h264_qsv'
    const out = await generateProxy('D:/v/a.mp4', undefined, undefined, { detect: async () => ['h264_qsv'], ffmpeg })
    expect(out).toBe(proxyPath('D:/v/a.mp4'))
    expect(calls().map((c) => c.enc)).toEqual(['h264_qsv'])
    expect(fs.readFileSync(out, 'utf-8')).toBe('proxy-data')
  })

  it('falls through to the next detected encoder when one fails at runtime', async () => {
    process.env.FAKE_OK_ENCODERS = 'libopenh264'
    await generateProxy('D:/v/a.mp4', undefined, undefined, { detect: async () => ['h264_amf', 'libopenh264'], ffmpeg })
    expect(calls().map((c) => c.enc)).toEqual(['h264_amf', 'libopenh264'])
  })

  it('reports a clear error when no encoder is available, and spawns nothing', async () => {
    await expect(generateProxy('D:/v/a.mp4', undefined, undefined, { detect: async () => [], ffmpeg })).rejects.toThrow(/H\.264/)
    expect(calls()).toEqual([])
  })

  it('reports a clear error when every encoder fails and leaves no files', async () => {
    process.env.FAKE_OK_ENCODERS = ''
    await expect(generateProxy('D:/v/a.mp4', undefined, undefined, { detect: async () => ['h264_nvenc'], ffmpeg })).rejects.toThrow(/h264_nvenc/)
    expect(fs.readdirSync(proxyDir())).toEqual([])
  })

  it('orderEncoders keeps only available ones in priority order', () => {
    expect(orderEncoders(['libopenh264', 'h264_qsv', 'libx264'])).toEqual(['h264_qsv', 'libopenh264'])
    expect(orderEncoders([])).toEqual([])
  })
})

describe('generateProxy partial file handling (C2)', () => {
  it('writes to a .partial.mp4 first; the final proxy path does not exist until success', async () => {
    process.env.FAKE_OK_ENCODERS = 'h264_nvenc'
    await generateProxy('D:/v/b.mp4', undefined, undefined, { detect: async () => ['h264_nvenc'], ffmpeg })
    const seen = JSON.parse(fs.readFileSync(process.env.FAKE_LOG!, 'utf-8').trim())
    const outArg = seen.args[seen.args.length - 1] as string
    expect(outArg.endsWith('.partial.mp4')).toBe(true)
    expect(fs.existsSync(outArg)).toBe(false)
    expect(fs.existsSync(proxyPath('D:/v/b.mp4'))).toBe(true)
  })

  it('failure leaves neither a final nor a partial file (proxy:get cannot see a broken file)', async () => {
    process.env.FAKE_OK_ENCODERS = ''
    await generateProxy('D:/v/c.mp4', undefined, undefined, { detect: async () => ['h264_nvenc'], ffmpeg }).catch(() => undefined)
    expect(fs.existsSync(proxyPath('D:/v/c.mp4'))).toBe(false)
    expect(fs.readdirSync(proxyDir())).toEqual([])
  })

  it('cancelAllProxies kills the running ffmpeg, rejects the job and removes the partial', async () => {
    process.env.FAKE_OK_ENCODERS = 'h264_nvenc'
    process.env.FAKE_SLEEP_MS = '30000'
    const p = generateProxy('D:/v/d.mp4', undefined, undefined, { detect: async () => ['h264_nvenc'], ffmpeg })
    const settled = p.then(() => 'ok', (e: Error) => e.message)
    for (let i = 0; i < 100 && calls().length === 0; i++) await new Promise((r) => setTimeout(r, 50))
    await cancelAllProxies()
    expect(await settled).toMatch(/取消|cancel/i)
    expect(fs.readdirSync(proxyDir())).toEqual([])
  })

  it('cleanStaleProxyPartials removes leftover .partial.mp4 but keeps finished proxies', () => {
    fs.mkdirSync(proxyDir(), { recursive: true })
    fs.writeFileSync(path.join(proxyDir(), 'abc.partial.mp4'), 'x')
    fs.writeFileSync(path.join(proxyDir(), 'abc.mp4'), 'x')
    cleanStaleProxyPartials()
    expect(fs.readdirSync(proxyDir())).toEqual(['abc.mp4'])
  })
})

describe('generateProxy PATH (C2)', () => {
  it('puts codecsDir() in PATH so libopenh264 can find its DLL', async () => {
    fs.mkdirSync(codecsDir(), { recursive: true })
    process.env.FAKE_OK_ENCODERS = 'libopenh264'
    await generateProxy('D:/v/e.mp4', undefined, undefined, { detect: async () => ['libopenh264'], ffmpeg })
    expect(calls()[0].path.startsWith(codecsDir() + path.delimiter)).toBe(true)
  })
})
