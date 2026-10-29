import { afterEach, describe, expect, test, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import { Readable } from 'stream'
import { downloadOpenH264, isAllowedOpenH264Url, openh264Url, OPENH264_BZ2_SHA256, OPENH264_BZ2_SIZE } from './codecs'

afterEach(() => vi.restoreAllMocks())

describe('isAllowedOpenH264Url', () => {
  test('the built-in URL is allowed and is https on the Cisco host', () => {
    expect(openh264Url().startsWith('https://ciscobinary.openh264.org/')).toBe(true)
    expect(isAllowedOpenH264Url(openh264Url())).toBe(true)
  })

  test.each([
    'http://ciscobinary.openh264.org/openh264-2.3.1-win64.dll.bz2',
    'https://ciscobinary.openh264.org.evil.com/openh264-2.3.1-win64.dll.bz2',
    'https://evil.com/ciscobinary.openh264.org/openh264-2.3.1-win64.dll.bz2',
    'https://user@ciscobinary.openh264.org@evil.com/x.bz2',
    'https://ciscobinary.openh264.org:8443/openh264-2.3.1-win64.dll.bz2',
    'https://ciscobinary.openh264.org/../etc/passwd',
    'https://ciscobinary.openh264.org/other.exe',
    'file:///C:/x.bz2',
    'not a url'
  ])('rejects %s', (u) => {
    expect(isAllowedOpenH264Url(u)).toBe(false)
  })
})

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-codecs-'))
}

describe('downloadOpenH264', () => {
  test('closes a rejected response before returning a content-length error', async () => {
    const dir = tmpDir()
    const stream = new Readable({ read() {} })
    try {
      await expect(downloadOpenH264({ dir, fetchStream: async () => ({ stream, contentLength: 1 }) })).rejects.toThrow('大小')
      expect(stream.destroyed).toBe(true)
    } finally { stream.destroy(); fs.rmSync(dir, { recursive: true, force: true }) }
  })

  test('stops the network source when opening the download destination fails', async () => {
    const dir = tmpDir()
    const create = fs.createWriteStream.bind(fs)
    vi.spyOn(fs, 'createWriteStream').mockImplementation(() => create(path.join(dir, 'missing', 'download.part')))
    const stream = new Readable({ read() {} })
    try {
      await expect(downloadOpenH264({ dir, fetchStream: async () => ({ stream, contentLength: OPENH264_BZ2_SIZE }) })).rejects.toThrow('ENOENT')
      expect(stream.destroyed).toBe(true)
      expect(fs.readdirSync(dir)).toEqual([])
    } finally { stream.destroy(); fs.rmSync(dir, { recursive: true, force: true }) }
  })
  test('refuses a non-allow-listed URL before any request', async () => {
    let called = false
    await expect(
      downloadOpenH264({
        url: 'https://evil.com/openh264-2.3.1-win64.dll.bz2',
        dir: tmpDir(),
        fetchStream: async () => {
          called = true
          throw new Error('x')
        },
        decompress: async () => undefined
      })
    ).rejects.toThrow()
    expect(called).toBe(false)
  })

  test('rejects a payload whose sha256 does not match (and removes the partial file)', async () => {
    const dir = tmpDir()
    const body = Buffer.from('not the real dll')
    await expect(
      downloadOpenH264({
        dir,
        fetchStream: async () => ({ stream: Readable.from([body]), contentLength: body.length }),
        decompress: async () => undefined,
        expected: { size: body.length, sha256: 'a'.repeat(64) }
      })
    ).rejects.toThrow(/雜湊|校驗|hash/i)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  test('rejects when the size is wrong', async () => {
    const dir = tmpDir()
    const body = Buffer.from('abc')
    await expect(
      downloadOpenH264({
        dir,
        fetchStream: async () => ({ stream: Readable.from([body]), contentLength: body.length }),
        decompress: async () => undefined,
        expected: { size: 999, sha256: createHash('sha256').update(body).digest('hex') }
      })
    ).rejects.toThrow()
    expect(fs.readdirSync(dir)).toEqual([])
  })

  test('verified payload is decompressed, progress is reported, bz2 removed', async () => {
    const dir = tmpDir()
    const body = Buffer.from('hello openh264')
    const sha = createHash('sha256').update(body).digest('hex')
    const ratios: number[] = []
    const out = await downloadOpenH264({
      dir,
      onProgress: (r) => ratios.push(r),
      fetchStream: async () => ({ stream: Readable.from([body.subarray(0, 5), body.subarray(5)]), contentLength: body.length }),
      decompress: async (_bz2, dll) => {
        fs.writeFileSync(dll, 'dll')
      },
      expected: { size: body.length, sha256: sha }
    })
    expect(path.basename(out)).toBe('openh264-2.3.1-win64.dll')
    expect(fs.readdirSync(dir)).toEqual(['openh264-2.3.1-win64.dll'])
    expect(ratios[ratios.length - 1]).toBe(1)
  })

  test('pinned constants look sane', () => {
    expect(OPENH264_BZ2_SHA256).toMatch(/^[0-9a-f]{64}$/)
    expect(OPENH264_BZ2_SIZE).toBeGreaterThan(100_000)
    expect(OPENH264_BZ2_SIZE).toBeLessThan(5_000_000)
  })
})
