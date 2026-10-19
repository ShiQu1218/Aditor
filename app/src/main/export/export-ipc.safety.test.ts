import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'apexhl-ipcs-'))
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
