import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { runExport } from './run'
import type { FfmpegJob } from './plan'

const FAKE = path.resolve(__dirname, '../../../test/fake-ffmpeg.mjs')
const ffmpeg = { bin: process.execPath, prefixArgs: [FAKE] }
let outDir: string
let tempDir: string
beforeEach(() => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apexhl-safe-out-'))
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apexhl-safe-tmp-'))
})
afterEach(() => {
  for (const d of [outDir, tempDir]) fs.rmSync(d, { recursive: true, force: true })
})
const job = (name: string, extra: Partial<FfmpegJob> = {}): FfmpegJob => {
  const output = path.join(outDir, name)
  return { args: ['-i', 'in.mp4', '-y', output], output, ...extra }
}
const opts = (jobs: FfmpegJob[]) => ({ jobs, totalEstimatedSeconds: 10, outDir, estimatedBytes: 1, ffmpeg, tempDir })

describe('runExport never overwrites an existing file (I6)', () => {
  it('a file that appeared at the destination during the export is kept; the new result gets a (2) name', async () => {
    const target = path.join(outDir, 'h.mp4')
    fs.writeFileSync(target, 'precious')
    const r = await runExport(opts([job('h.mp4')]))
    expect(r.ok).toBe(true)
    expect(fs.readFileSync(target, 'utf-8')).toBe('precious')
    const outputs = (r as { outputs: string[] }).outputs
    expect(outputs).toEqual([path.join(outDir, 'h (2).mp4')])
    expect(fs.readFileSync(outputs[0], 'utf-8')).toBe('complete-data')
  })
})

describe('runExport intermediates (I9)', () => {
  it('intermediate segments are not reported as outputs and are deleted afterwards', async () => {
    const seg1 = job('.apexhl-seg-x-1.mp4', { intermediate: true })
    const seg2 = job('.apexhl-seg-x-2.mp4', { intermediate: true })
    const final = job('final.mp4')
    const r = await runExport({ ...opts([seg1, seg2, final]), concatListContent: 'x' })
    expect(r.ok).toBe(true)
    expect((r as { outputs: string[] }).outputs).toEqual([final.output])
    expect(fs.readdirSync(outDir)).toEqual(['final.mp4'])
  })
})
