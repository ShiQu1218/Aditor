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
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-safe-out-'))
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-safe-tmp-'))
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
  it.each([0, 1])('keeps an existing partial source on success or failure (exit %s)', async (exitCode) => {
    const source = path.join(outDir, 'highlight_1.partial.mp4')
    fs.writeFileSync(source, 'precious-source')
    const output = path.join(outDir, 'highlight_1.mp4')
    const script = path.join(tempDir, 'ffmpeg.cjs')
    fs.writeFileSync(script, `const fs=require('fs');const a=process.argv.slice(2);if(fs.readFileSync(a[a.indexOf('-i')+1],'utf8')!=='precious-source')process.exit(9);fs.writeFileSync(a.at(-1),'exported');process.exit(${exitCode});`)
    const r = await runExport({ ...opts([{ output, args: ['-i', source, '-y', output] }]), ffmpeg: { bin: process.execPath, prefixArgs: [script] } })
    expect(r.ok).toBe(exitCode === 0)
    expect(fs.readFileSync(source, 'utf8')).toBe('precious-source')
    expect(fs.readdirSync(outDir).sort()).toEqual((exitCode ? ['highlight_1.partial.mp4'] : ['highlight_1.mp4', 'highlight_1.partial.mp4']).sort())
  })

  it('does not rewrite the input when the source also has the intended output name', async () => {
    const j = job('h.mp4')
    fs.writeFileSync(j.output, 'original')
    const script = path.join(tempDir, 'ffmpeg.cjs')
    fs.writeFileSync(script, "const fs=require('fs');const a=process.argv.slice(2);if(fs.readFileSync(a[a.indexOf('-i')+1],'utf8')!=='original')process.exit(9);fs.writeFileSync(a.at(-1),'exported');")
    const r = await runExport({ ...opts([{ ...j, args: ['-i', j.output, '-y', j.output] }]), ffmpeg: { bin: process.execPath, prefixArgs: [script] } })
    expect(r.ok).toBe(true)
    expect(fs.readFileSync(j.output, 'utf8')).toBe('original')
    expect(r.outputs).toEqual([path.join(outDir, 'h (2).mp4')])
  })

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
    const seg1 = job('.aditor-seg-x-1.mp4', { intermediate: true })
    const seg2 = job('.aditor-seg-x-2.mp4', { intermediate: true })
    const final = job('final.mp4')
    const r = await runExport({ ...opts([seg1, seg2, final]), concatListContent: 'x' })
    expect(r.ok).toBe(true)
    expect((r as { outputs: string[] }).outputs).toEqual([final.output])
    expect(fs.readdirSync(outDir)).toEqual(['final.mp4'])
  })
})

describe('runExport progress', () => {
  it('weights percent by job length so two equal clips report 0-50% then 50-100%', async () => {
    const script = path.join(tempDir, 'ffmpeg.cjs')
    fs.writeFileSync(script, "const fs=require('fs');const a=process.argv.slice(2);for(const us of [0,5e6,10e6])process.stdout.write('out_time_us='+us+String.fromCharCode(10));fs.writeFileSync(a.at(-1),'x');")
    const seen: number[] = []
    const r = await runExport(
      { ...opts([job('a.mp4', { durationSec: 10 }), job('b.mp4', { durationSec: 10 })]), totalEstimatedSeconds: 20, ffmpeg: { bin: process.execPath, prefixArgs: [script] } },
      { onProgress: (p) => seen.push(p.percent) }
    )
    expect(r).toEqual({ ok: true, outputs: [path.join(outDir, 'a.mp4'), path.join(outDir, 'b.mp4')] })
    expect(seen).toEqual([0, 25, 50, 50, 75, 100])
  })
})
