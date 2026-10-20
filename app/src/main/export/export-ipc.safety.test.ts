import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import { createExportService } from './export-ipc'

const FAKE = path.resolve(__dirname, '../../../test/fake-ffmpeg.mjs')
let root: string
let outDir: string
let srcA: string
let srcB: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-ipcs-'))
  outDir = path.join(root, 'out')
  fs.mkdirSync(outDir)
  srcA = path.join(root, 'a.mp4')
  srcB = path.join(root, 'b.mp4')
  fs.writeFileSync(srcA, 'x')
  fs.writeFileSync(srcB, 'x')
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const sender = () => Object.assign(new EventEmitter(), { isDestroyed: () => false, send: () => undefined })
const svc = (probe?: (s: string) => Promise<unknown>) =>
  createExportService({ ffmpeg: { bin: process.execPath, prefixArgs: [FAKE] }, tempDir: path.join(root, 'tmp'), probe })

describe('export:start never overwrites existing exports (I6)', () => {
  it('a second export with the same name gets " (2)" and a notice; the first result is untouched', async () => {
    const req = { items: [{ id: '1', source: srcA, start: 0, end: 5 }], mode: 'separate', quality: 'copy', outDir, baseName: 'clip' }
    const r1 = await svc().start(sender(), req)
    expect(r1).toMatchObject({ ok: true, outputs: [path.join(outDir, 'Clips', 'clip_1.mp4')] })
    fs.writeFileSync(path.join(outDir, 'Clips', 'clip_1.mp4'), 'first-result')
    const r2 = await svc().start(sender(), req)
    expect(r2).toMatchObject({ ok: true, outputs: [path.join(outDir, 'Clips', 'clip (2)_1.mp4')] })
    expect((r2 as { notices: string[] }).notices.some((n) => n.includes('clip (2)'))).toBe(true)
    expect(fs.readFileSync(path.join(outDir, 'Clips', 'clip_1.mp4'), 'utf-8')).toBe('first-result')
  })
})

describe('export:start with mixed sources (I9)', () => {
  it('engine probe only knows codec/size: two different sources in copy+concat switch to precise normalised segments', async () => {
    const probe = async () => ({ codec: 'h264', width: 1920, height: 1080 })
    const r = await svc(probe).start(sender(), {
      items: [
        { id: '1', source: srcA, start: 0, end: 5 },
        { id: '2', source: srcB, start: 1, end: 4 }
      ],
      mode: 'concat',
      quality: 'copy',
      encoder: 'libopenh264',
      outDir,
      baseName: 'joined'
    })
    expect(r).toMatchObject({ ok: true, outputs: [path.join(outDir, 'Merged', 'joined.mp4')] })
    expect((r as { notices: string[] }).notices.length).toBeGreaterThan(0)
    expect(fs.readdirSync(path.join(outDir, 'Merged'))).toEqual(['joined.mp4'])
  })
})

describe('export:start disk estimates', () => {
  it.each(['separate', 'concat'] as const)('rejects insufficient space for a 4K60 %s export before starting ffmpeg', async (mode) => {
    const stats = await fs.promises.statfs(outDir)
    const statfs = vi.spyOn(fs.promises, 'statfs').mockImplementation(async () => ({ ...stats, bavail: 1024 ** 3, bsize: 1 }))
    try {
      const service = createExportService({
        ffmpeg: { bin: process.execPath, prefixArgs: [FAKE] },
        probe: async (source) => ({ codec: 'h264', width: source === srcA ? 3840 : 1920, height: source === srcA ? 2160 : 1080, fps: 60 }),
        hasAudio: async () => true
      })
      const items = [{ id: '1', source: srcA, start: 0, end: 60 }]
      if (mode === 'concat') items.push({ id: '2', source: srcB, start: 0, end: 30 })
      const result = await service.start(sender(), { items, mode, quality: mode === 'concat' ? 'copy' : 'precise', encoder: 'libopenh264', outDir, baseName: 'large' })
      expect(result).toMatchObject({ ok: false, outputs: [], error: expect.stringContaining('磁碟剩餘空間不足') })
      expect(fs.readdirSync(path.join(outDir, mode === 'concat' ? 'Merged' : 'Clips'))).toEqual([])
    } finally {
      statfs.mockRestore()
    }
  })
})
