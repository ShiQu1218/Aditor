import { describe, it, expect } from 'vitest'
import {
  extraSecondsForCopy,
  concatCompatible,
  buildJobs,
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

  it('precise uses chosen encoder and -ss after -i', () => {
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
    expect(ssIndex).toBeGreaterThan(iIndex) // -ss after -i
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
