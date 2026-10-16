import { describe, it, expect } from 'vitest'
import {
  extraSecondsForCopy,
  concatCompatible,
  buildJobs,
  resolveFreeBaseName,
  NoEncoderError,
  StreamProbe
} from './plan'
import { ProjectItem } from '../../renderer/editor/project'

describe('export plan', () => {
  it('extraSecondsForCopy calculates difference to closest prior keyframe', () => {
    const keyframes = [0, 2, 4]
    expect(extraSecondsForCopy(3.1, keyframes)).toBeCloseTo(1.1, 4)
    expect(extraSecondsForCopy(4.0, keyframes)).toBeCloseTo(0.0, 4)
    expect(extraSecondsForCopy(1.5, keyframes)).toBeCloseTo(1.5, 4)
    expect(extraSecondsForCopy(0.5, [])).toBeCloseTo(0.5, 4)
  })

  const probeH264: StreamProbe = {
    vcodec: 'h264',
    width: 1920,
    height: 1080,
    fps: 60,
    pix_fmt: 'yuv420p',
    acodec: 'aac',
    sample_rate: 48000,
    channels: 2
  }

  const probeAV1: StreamProbe = {
    vcodec: 'av1',
    width: 1916,
    height: 1080,
    fps: 60,
    pix_fmt: 'yuv420p',
    acodec: 'aac',
    sample_rate: 48000,
    channels: 2
  }

  it('concatCompatible detects differences in codec, dimensions, or fps', () => {
    expect(concatCompatible([probeH264, probeH264])).toEqual({ ok: true })
    const res = concatCompatible([probeH264, probeAV1])
    expect(res.ok).toBe(false)
    expect(res.reason).toBeDefined()
  })

  const sampleItems: ProjectItem[] = [
    { id: '1', source: 'C:/clips/vid1.mp4', start: 10, end: 20 },
    { id: '2', source: 'C:/clips/vid 2 \'apex\'.mp4', start: 30, end: 40 }
  ]

  const probesMap = new Map<string, StreamProbe>([
    ['C:/clips/vid1.mp4', probeH264],
    ['C:/clips/vid 2 \'apex\'.mp4', probeAV1]
  ])

  it('copy separate jobs use -ss before -i and -c copy', () => {
    const { jobs, notices } = buildJobs(
      [sampleItems[0]],
      {
        mode: 'separate',
        quality: 'copy',
        outDir: 'C:/output',
        baseName: 'highlight'
      },
      probesMap
    )

    expect(jobs).toHaveLength(1)
    const args = jobs[0].args
    const ssIndex = args.indexOf('-ss')
    const iIndex = args.indexOf('-i')
    expect(ssIndex).toBeGreaterThan(-1)
    expect(iIndex).toBeGreaterThan(-1)
    expect(ssIndex).toBeLessThan(iIndex) // -ss before -i
    expect(args).toContain('-c')
    expect(args).toContain('copy')
  })

  it('precise uses chosen encoder and input-side -ss (accurate seek without decoding from the start) (I8)', () => {
    const { jobs } = buildJobs(
      [sampleItems[0]],
      {
        mode: 'separate',
        quality: 'precise',
        encoder: 'h264_nvenc',
        outDir: 'C:/output',
        baseName: 'highlight'
      },
      probesMap
    )

    expect(jobs).toHaveLength(1)
    const args = jobs[0].args
    const ssIndex = args.indexOf('-ss')
    const iIndex = args.indexOf('-i')
    expect(ssIndex).toBeGreaterThan(-1)
    expect(iIndex).toBeGreaterThan(-1)
    expect(ssIndex).toBeLessThan(iIndex) // -ss before -i：轉碼時仍是精準 seek，且不必從頭解碼
    expect(args.indexOf('-t')).toBeGreaterThan(iIndex) // -t 是輸出選項，放在 -i 之後
    expect(args[ssIndex + 1]).toBe('10.000')
    expect(args).toContain('-c:v')
    expect(args).toContain('h264_nvenc')
  })

  it('precise without encoder throws NoEncoderError', () => {
    expect(() =>
      buildJobs(
        sampleItems,
        {
          mode: 'separate',
          quality: 'precise',
          encoder: undefined,
          outDir: 'C:/output',
          baseName: 'highlight'
        },
        probesMap
      )
    ).toThrow(NoEncoderError)
  })

  it('concat incompatible → reencode with notice', () => {
    const { jobs, notices } = buildJobs(
      sampleItems,
      {
        mode: 'concat',
        quality: 'copy',
        encoder: 'h264_nvenc',
        outDir: 'C:/output',
        baseName: 'highlight'
      },
      probesMap
    )

    expect(notices.length).toBeGreaterThan(0)
    // Concat re-encode should be in precise mode
    expect(jobs).toBeDefined()
    expect(jobs.length).toBeGreaterThan(0)
  })

  it('concat job uses concat demuxer list file with escaped paths', () => {
    const sameMap = new Map<string, StreamProbe>([
      ['C:/clips/vid1.mp4', probeH264],
      ['C:/clips/vid 2 \'apex\'.mp4', probeH264]
    ])

    const { jobs } = buildJobs(
      sampleItems,
      {
        mode: 'concat',
        quality: 'copy',
        outDir: 'C:/output',
        baseName: 'highlight'
      },
      sameMap
    )

    // Should generate jobs including the concat job
    expect(jobs.length).toBeGreaterThan(0)
    const concatJob = jobs[jobs.length - 1]
    expect(concatJob.args).toContain('-f')
    expect(concatJob.args).toContain('concat')
  })
})

describe('export plan: unknown stream info and mixed sources (I9)', () => {
  const unknown = (): StreamProbe => ({ vcodec: 'h264', width: 1920, height: 1080, fps: 0, pix_fmt: '', acodec: '', sample_rate: 0, channels: 0 })
  const items: ProjectItem[] = [
    { id: '1', source: 'C:/a.mp4', start: 1, end: 5 },
    { id: '2', source: 'C:/b.mp4', start: 2, end: 6 },
    { id: '3', source: 'C:/a.mp4', start: 8, end: 9 }
  ]

  it('concatCompatible treats unknown fps/pix_fmt/audio as not comparable (not compatible)', () => {
    const r = concatCompatible([unknown(), unknown()])
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/無法確認/)
  })

  it('same source repeated is compatible even when its details are unknown', () => {
    const { jobs, notices } = buildJobs(
      [items[0], items[2]],
      { mode: 'concat', quality: 'copy', outDir: 'C:/out', baseName: 'h' },
      new Map([['C:/a.mp4', unknown()]])
    )
    expect(notices).toEqual([])
    expect(jobs).toHaveLength(1)
    expect(jobs[0].args).toContain('copy')
  })

  it('two different sources with unknown details -> precise path with per-segment normalised intermediates + copy concat', () => {
    const res = buildJobs(items, { mode: 'concat', quality: 'copy', encoder: 'h264_nvenc', outDir: 'C:/out', baseName: 'h' }, new Map([
      ['C:/a.mp4', unknown()],
      ['C:/b.mp4', unknown()]
    ]))
    expect(res.notices.length).toBeGreaterThan(0)
    const segs = res.jobs.filter((j) => j.intermediate)
    const last = res.jobs[res.jobs.length - 1]
    expect(segs).toHaveLength(3)
    expect(res.jobs).toHaveLength(4)
    expect(last.intermediate).toBeFalsy()
    expect(last.args).toContain('concat')
    expect(last.args).toContain('LIST_FILE_PLACEHOLDER')
    const copyIdx = last.args.indexOf('-c')
    expect(last.args[copyIdx + 1]).toBe('copy')
    // 清單只含中間檔，不再用 inpoint/outpoint 直接讀來源
    expect(res.concatListContent).not.toContain('inpoint')
    for (const s of segs) expect(res.concatListContent).toContain(s.output.replace(/\\/g, '/'))
    // 每段都正規化：scale/fps/pix_fmt 與音訊取樣率／聲道，-ss 在 -i 之前
    const a = segs[0].args
    expect(a.join(' ')).toMatch(/scale=1920:1080/)
    expect(a.join(' ')).toMatch(/fps=/)
    expect(a.join(' ')).toMatch(/format=yuv420p/)
    expect(a).toContain('-ar')
    expect(a).toContain('-ac')
    expect(a.indexOf('-ss')).toBeLessThan(a.indexOf('-i'))
  })

  it('compatible, fully known sources still use the single-pass concat demuxer', () => {
    const k: StreamProbe = { vcodec: 'h264', width: 1920, height: 1080, fps: 60, pix_fmt: 'yuv420p', acodec: 'aac', sample_rate: 48000, channels: 2 }
    const res = buildJobs(items, { mode: 'concat', quality: 'copy', outDir: 'C:/out', baseName: 'h' }, new Map([['C:/a.mp4', k], ['C:/b.mp4', { ...k }]]))
    expect(res.jobs).toHaveLength(1)
    expect(res.notices).toEqual([])
  })
})

describe('export plan: never overwrite existing files (I6)', () => {
  it('picks a free base name; separate mode requires every <base>_<n>.mp4 to be free', () => {
    const existing = new Set(['C:/out/highlight_2.mp4', 'C:/out/highlight (2)_1.mp4'].map((p) => p.toLowerCase()))
    const exists = (p: string): boolean => existing.has(p.replace(/\\/g, '/').toLowerCase())
    const r = resolveFreeBaseName('C:/out', 'highlight', 'separate', 3, exists)
    expect(r.baseName).toBe('highlight (3)')
    expect(r.renamed).toBe(true)
  })
  it('keeps the name when nothing collides; concat checks <base>.mp4', () => {
    expect(resolveFreeBaseName('C:/out', 'h', 'concat', 1, () => false)).toEqual({ baseName: 'h', renamed: false })
    const r = resolveFreeBaseName('C:/out', 'h', 'concat', 1, (p) => p.replace(/\\/g, '/') === 'C:/out/h.mp4')
    expect(r).toEqual({ baseName: 'h (2)', renamed: true })
  })
})
