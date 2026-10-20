import { describe, it, expect } from 'vitest'
import {
  extraSecondsForCopy,
  concatCompatible,
  buildJobs,
  resolveFreeBaseName,
  NoEncoderError,
  StreamProbe,
  copyCutArgs,
  concatList,
  resolveQuality,
  estimateOutputBytes
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

  it('estimates match the peak rates of separate and normalized concat jobs', () => {
    const probes = new Map<string, StreamProbe>([
      [sampleItems[0].source, { ...probeH264, width: 3840, height: 2160, fps: 30 }],
      [sampleItems[1].source, probeH264]
    ])
    for (const mode of ['separate', 'concat'] as const) {
      const { jobs } = buildJobs(sampleItems, { mode, quality: 'precise', encoder: 'h264_nvenc', outDir: 'C:/out', baseName: 'h' }, probes)
      const rendered = mode === 'concat' ? jobs.filter((job) => job.intermediate) : jobs
      const expected = rendered.reduce((sum, job, i) => {
        const peak = Number(job.args[job.args.indexOf('-maxrate') + 1].replace('k', ''))
        return sum + (sampleItems[i].end - sampleItems[i].start) * (peak + 192) * 1000 / 8
      }, 0)
      expect(estimateOutputBytes(sampleItems, 'precise', probes, mode)).toBe(Math.ceil(expected))
    }
  })

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
    expect(ssIndex).toBeLessThan(iIndex) // -ss before -i: still precise when transcoding and avoids decoding from the start.
    expect(args.indexOf('-t')).toBeGreaterThan(iIndex) // -t is an output option, so it follows -i.
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
    // Stream-copy each segment to an intermediate file, then join them with concat demuxer copy in the final job.
    expect(jobs).toHaveLength(3)
    expect(jobs.slice(0, 2).every((j) => j.intermediate)).toBe(true)
    for (const j of jobs) expect(j.args).toContain('copy')
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
    // Copy video directly and encode the complete audio stream (intermediate files use PCM) to AAC once.
    expect(last.args[last.args.indexOf('-c:v') + 1]).toBe('copy')
    expect(last.args[last.args.indexOf('-c:a') + 1]).toBe('aac')
    // The list contains only intermediate files; it no longer reads sources directly with inpoint/outpoint.
    expect(res.concatListContent).not.toContain('inpoint')
    for (const s of segs) expect(res.concatListContent).toContain(s.output.replace(/\\/g, '/'))
    // Normalize every segment (scale/fps/pix_fmt and audio sample rate/channels); -ss comes before -i.
    const a = segs[0].args
    expect(a.join(' ')).toMatch(/scale=1920:1080/)
    expect(a.join(' ')).toMatch(/fps=/)
    expect(a.join(' ')).toMatch(/format=yuv420p/)
    expect(a).toContain('-ar')
    expect(a).toContain('-ac')
    expect(a.indexOf('-ss')).toBeLessThan(a.indexOf('-i'))
  })

  it('mixed specs render to the largest/fastest timeline with Lanczos scaling and an explicit high bitrate', () => {
    const k: StreamProbe = { vcodec: 'h264', width: 1280, height: 720, fps: 30, pix_fmt: 'yuv420p', acodec: 'aac', sample_rate: 48000, channels: 2 }
    const res = buildJobs(items, { mode: 'concat', quality: 'precise', encoder: 'h264_nvenc', outDir: 'C:/out', baseName: 'h' }, new Map([
      ['C:/a.mp4', k],
      ['C:/b.mp4', { ...k, width: 1920, height: 1080, fps: 60 }]
    ]))
    for (const s of res.jobs.filter((j) => j.intermediate)) {
      expect(s.args.join(' ')).toContain('scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos')
      expect(s.args.join(' ')).toContain('fps=60')
      expect(s.args[s.args.indexOf('-b:v') + 1]).toBe('24900k')
    }
  })

  it('compatible, fully known sources stay lossless: per-segment stream copy + copy concat, no notice', () => {
    const k: StreamProbe = { vcodec: 'h264', width: 1920, height: 1080, fps: 60, pix_fmt: 'yuv420p', acodec: 'aac', sample_rate: 48000, channels: 2 }
    const res = buildJobs(items, { mode: 'concat', quality: 'copy', outDir: 'C:/out', baseName: 'h' }, new Map([['C:/a.mp4', k], ['C:/b.mp4', { ...k }]]))
    expect(res.jobs).toHaveLength(4)
    expect(res.notices).toEqual([])
    expect(res.jobs.every((j) => !j.args.includes('-c:v'))).toBe(true)
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

describe('export plan: clip boundaries play cleanly (no pre-roll, no overlapping timestamps)', () => {
  const src = 'C:/rec/game.mkv'
  const clipItems: ProjectItem[] = [
    { id: '1', source: src, start: 13.4, end: 21.7 },
    { id: '2', source: src, start: 45.1, end: 52.3 }
  ]
  const probes = new Map<string, StreamProbe>([[src, { vcodec: 'av1', width: 1920, height: 1080, fps: 0, pix_fmt: '', acodec: '', sample_rate: 0, channels: 0 }]])
  const valueAfter = (args: string[], flag: string): string => args[args.indexOf(flag) + 1]

  it('copy cut with a known keyframe starts exactly on it: seek past the ffmpeg 3/23 s dts heuristic, -itsoffset pulls time 0 back to the keyframe', () => {
    const args = copyCutArgs(clipItems[0], { keyframe: 12, end: 21.708 }, 'C:/out/a.mp4')
    const pad = 3 / 23 + 0.001
    expect(Number(valueAfter(args, '-ss'))).toBeCloseTo(12 + pad, 6)
    expect(Number(valueAfter(args, '-itsoffset'))).toBeCloseTo(pad, 6)
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'))
    expect(args.indexOf('-itsoffset')).toBeLessThan(args.indexOf('-i'))
    // From the keyframe through the adjusted end (the extra lead-in is the "may add about X seconds" shown in the UI).
    expect(Number(valueAfter(args, '-t'))).toBeCloseTo(21.708 - 12, 6)
    expect(valueAfter(args, '-c')).toBe('copy')
    // Audio does not start before the keyframe; no edit list is used to hide frames.
    expect(valueAfter(args, '-copypriorss:a')).toBe('0')
    expect(args).not.toContain('-avoid_negative_ts')
    expect(args.slice(-2)).toEqual(['-y', 'C:/out/a.mp4'])
    // Drop open-GOP leading B-frames (display time is before the keyframe).
    expect(valueAfter(args, '-bsf:v')).toBe('noise=drop=lt(pts\\,startpts)')
  })

  it('a separate video cut keeps audio running until the last video frame has been shown', () => {
    const args = copyCutArgs(clipItems[0], { keyframe: 12, end: 21.74, videoCut: 21.708 }, 'C:/out/a.mp4')
    expect(Number(valueAfter(args, '-t'))).toBeCloseTo(9.74, 6)
    // Drop video packets whose DTS (relative to output time 0) is >= 9.708.
    expect(valueAfter(args, '-bsf:v')).toBe('noise=drop=lt(pts\\,startpts)+gte(dts*tb\\,9.708000)')
  })

  it('copy cut without keyframe info falls back to seeking the clip start and shifting everything to zero', () => {
    const bad = [null, undefined, { keyframe: Number.NaN, end: 21.7 }, { keyframe: 14, end: 21.7 } /* After the start: untrusted. */, { keyframe: 12, end: 11 }]
    for (const kf of bad) {
      const args = copyCutArgs(clipItems[0], kf, 'C:/out/a.mp4')
      expect(valueAfter(args, '-ss')).toBe('13.400')
      expect(valueAfter(args, '-t')).toBe('8.300')
      expect(valueAfter(args, '-avoid_negative_ts')).toBe('make_zero')
      expect(args).not.toContain('-itsoffset')
    }
  })

  it('every cut keeps one video + optional first audio track and drops source chapters/metadata', () => {
    const jobs = [
      ...buildJobs(clipItems, { mode: 'separate', quality: 'copy', outDir: 'C:/out', baseName: 'h', copyCuts: [{ keyframe: 12, end: 21.7 }, { keyframe: 43.75, end: 52.3 }] }, probes).jobs,
      ...buildJobs(clipItems, { mode: 'separate', quality: 'precise', encoder: 'h264_nvenc', outDir: 'C:/out', baseName: 'h' }, probes).jobs
    ]
    for (const j of jobs) {
      expect(j.args.join(' ')).toContain('-map 0:v:0 -map 0:a:0?')
      expect(j.args.join(' ')).toContain('-map_metadata -1 -map_chapters -1')
    }
  })

  it('separate copy uses the per-item cut', () => {
    const { jobs } = buildJobs(clipItems, { mode: 'separate', quality: 'copy', outDir: 'C:/out', baseName: 'h', copyCuts: [{ keyframe: 12, end: 21.7 }, null] }, probes)
    expect(jobs[0].args).toContain('-itsoffset')
    expect(jobs[1].args).toContain('make_zero')
  })

  it('concat copy never reads the source through concat inpoint/outpoint (pre-roll packets overlapped the previous clip)', () => {
    const cuts = [{ keyframe: 12, end: 21.7 }, { keyframe: 43.75, end: 52.3 }]
    const res = buildJobs(clipItems, { mode: 'concat', quality: 'copy', outDir: 'C:/out', baseName: 'h', copyCuts: cuts }, probes)
    expect(res.notices).toEqual([])
    const [s1, s2, final] = res.jobs
    expect(s1.intermediate && s2.intermediate).toBe(true)
    expect(s1.output).toMatch(/\.aditor-seg-\w+-1\.mp4$/)
    expect(s1.args).toEqual(copyCutArgs(clipItems[0], cuts[0], s1.output))
    expect(s2.args).toEqual(copyCutArgs(clipItems[1], cuts[1], s2.output))
    expect(final.intermediate).toBeFalsy()
    expect(final.args).toContain('LIST_FILE_PLACEHOLDER')
    expect(valueAfter(final.args, '-c')).toBe('copy')
    expect(res.concatListContent).not.toMatch(/inpoint|outpoint/)
    expect(res.concatListContent).toBe(concatList([s1.output, s2.output]))
  })

  it('concat precise: each clip is encoded on its own with PCM audio (no AAC priming per junction), then video copied and audio encoded once', () => {
    const res = buildJobs(clipItems, { mode: 'concat', quality: 'precise', encoder: 'h264_nvenc', outDir: 'C:/out', baseName: 'h' }, probes)
    expect(res.jobs).toHaveLength(3)
    const [s1, , final] = res.jobs
    expect(s1.output).toMatch(/\.mov$/)
    expect(valueAfter(s1.args, '-ss')).toBe('13.400')
    expect(s1.args.indexOf('-ss')).toBeLessThan(s1.args.indexOf('-i'))
    expect(valueAfter(s1.args, '-c:v')).toBe('h264_nvenc')
    expect(valueAfter(s1.args, '-c:a')).toBe('pcm_s16le')
    // Same source: do not change resolution or frame rate, and show no "different specs" notice.
    expect(s1.args).not.toContain('-vf')
    expect(res.notices).toEqual([])
    expect(valueAfter(final.args, '-c:v')).toBe('copy')
    expect(valueAfter(final.args, '-c:a')).toBe('aac')
    expect(valueAfter(final.args, '-af')).toMatch(/^aresample=async=1/)
    expect(res.concatListContent).not.toMatch(/inpoint|outpoint/)
  })

  it('concatList writes a duration for every measured segment and skips unknown ones', () => {
    expect(concatList(["C:\\o\\a'1.mp4", 'C:/o/b.mp4', 'C:/o/c.mp4'], [9.7171667, null, 0])).toBe(
      "file 'C:/o/a'\\''1.mp4'\nduration 9.717167\nfile 'C:/o/b.mp4'\nfile 'C:/o/c.mp4'\n"
    )
  })

  it('resolveQuality reports the fallback to precise for incompatible copy concat only', () => {
    const two = new Map<string, StreamProbe>([...probes, ['C:/rec/other.mkv', probes.get(src)!]])
    const mixed = [...clipItems, { id: '3', source: 'C:/rec/other.mkv', start: 1, end: 2 }]
    expect(resolveQuality(mixed, { mode: 'concat', quality: 'copy' }, two).quality).toBe('precise')
    expect(resolveQuality(mixed, { mode: 'separate', quality: 'copy' }, two)).toEqual({ quality: 'copy', notices: [] })
    expect(resolveQuality(clipItems, { mode: 'concat', quality: 'copy' }, probes)).toEqual({ quality: 'copy', notices: [] })
  })
})
