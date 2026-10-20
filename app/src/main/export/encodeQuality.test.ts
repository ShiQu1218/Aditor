import { describe, expect, it } from 'vitest'
import type { StreamProbe } from '../../shared/exportCompat'
import { targetBitrateKbps, timelineSpec, videoEncodeArgs } from './encodeQuality'

const probe = (width: number, height: number, fps: number): StreamProbe =>
  ({ vcodec: 'h264', width, height, fps, pix_fmt: 'yuv420p', acodec: 'aac', sample_rate: 48000, channels: 2 })
const valueAfter = (args: string[], flag: string): string | undefined => args[args.indexOf(flag) + 1]

describe('targetBitrateKbps', () => {
  it('scales with pixel rate like an "automatic best" render preset', () => {
    expect(targetBitrateKbps({ width: 1920, height: 1080, fps: 60 })).toBe(24_900)
    expect(targetBitrateKbps({ width: 1920, height: 1080, fps: 30 })).toBe(12_400)
    expect(targetBitrateKbps({ width: 2560, height: 1440, fps: 60 })).toBe(44_200)
  })

  it('clamps tiny and huge outputs', () => {
    expect(targetBitrateKbps({ width: 640, height: 360, fps: 30 })).toBe(8_000)
    expect(targetBitrateKbps({ width: 7680, height: 4320, fps: 60 })).toBe(150_000)
  })
})

describe('timelineSpec', () => {
  it('uses the largest resolution and highest frame rate so no source is downscaled or decimated', () => {
    expect(timelineSpec([probe(1280, 720, 30), probe(2560, 1440, 60), probe(1920, 1080, 144)]))
      .toEqual({ width: 2560, height: 1440, fps: 144 })
  })

  it('sizes the canvas to contain every source regardless of orientation or order', () => {
    const landscape = probe(1920, 1080, 60)
    const portrait = probe(1080, 1920, 60)
    expect(timelineSpec([landscape, portrait])).toEqual({ width: 1920, height: 1920, fps: 60 })
    expect(timelineSpec([portrait, landscape])).toEqual({ width: 1920, height: 1920, fps: 60 })
  })

  it('keeps dimensions even and falls back to 1080p60 when nothing is known', () => {
    expect(timelineSpec([probe(1919, 1081, 59.94)])).toEqual({ width: 1918, height: 1080, fps: 59.94 })
    expect(timelineSpec([undefined, probe(0, 0, 0)])).toEqual({ width: 1920, height: 1080, fps: 60 })
  })
})

describe('videoEncodeArgs', () => {
  const spec = { width: 1920, height: 1080, fps: 60 }

  it('NVENC uses the slow high-quality preset with constant quality capped by a peak rate', () => {
    const a = videoEncodeArgs('h264_nvenc', spec)
    expect(valueAfter(a, '-c:v')).toBe('h264_nvenc')
    expect(valueAfter(a, '-preset')).toBe('p6')
    expect(valueAfter(a, '-tune')).toBe('hq')
    expect(valueAfter(a, '-rc')).toBe('vbr')
    expect(valueAfter(a, '-cq')).toBe('19')
    expect(valueAfter(a, '-b:v')).toBe('24900k')
    expect(valueAfter(a, '-maxrate')).toBe('37350k')
    expect(valueAfter(a, '-profile:v')).toBe('high')
  })

  it('QSV, AMF and OpenH264 get explicit target and peak bitrates', () => {
    for (const enc of ['h264_qsv', 'h264_amf', 'libopenh264']) {
      const a = videoEncodeArgs(enc, spec)
      expect(valueAfter(a, '-c:v')).toBe(enc)
      expect(valueAfter(a, '-b:v')).toBe('24900k')
      expect(valueAfter(a, '-maxrate')).toBe('37350k')
      expect(valueAfter(a, '-bufsize')).toBe('49800k')
    }
    expect(valueAfter(videoEncodeArgs('h264_amf', spec), '-quality')).toBe('quality')
    expect(valueAfter(videoEncodeArgs('h264_qsv', spec), '-preset')).toBe('slow')
  })

  it('an unknown encoder still gets a bitrate instead of its default', () => {
    expect(valueAfter(videoEncodeArgs('foo_enc', spec), '-b:v')).toBe('24900k')
  })
})
