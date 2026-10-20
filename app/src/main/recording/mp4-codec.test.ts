import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { codecName, initCodecs, initMimeType } from './mp4-codec'

// Generated with build/ffmpeg (default HEVC sample description hev1) using *_nvenc + AAC and `frag_keyframe+empty_moov+default_base_moof`, then truncated before moof.
const fixture = (name: string): Uint8Array => new Uint8Array(fs.readFileSync(path.join(__dirname, '__fixtures__', name)))

function box(type: string, ...children: Uint8Array[]): Uint8Array {
  const body = Buffer.concat(children)
  const head = Buffer.alloc(8)
  head.writeUInt32BE(8 + body.length)
  head.write(type, 4, 'ascii')
  return Buffer.concat([head, body])
}
const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values)
function initWith(entry: Uint8Array): Uint8Array {
  const stsd = box('stsd', bytes(0, 0, 0, 0, 0, 0, 0, 1), entry)
  return Buffer.concat([box('ftyp', Buffer.from('isom')), box('moov', box('trak', box('mdia', box('minf', box('stbl', stsd)))))])
}
const visual = (fourcc: string, config: Uint8Array): Uint8Array => box(fourcc, new Uint8Array(78), config)

describe('init.mp4 → RFC 6381 codecs', () => {
  it('parses real NVENC initialization segments (HEVC/H.264/AV1 + AAC)', () => {
    expect(initMimeType(fixture('init-hevc.mp4'))).toBe('video/mp4; codecs="hev1.1.6.L90.90, mp4a.40.2"')
    // The FFmpeg DASH muxer writes avc1.640015, av01.0.01M.08, and mp4a.40.2 for the same file.
    expect(initMimeType(fixture('init-h264.mp4'))).toBe('video/mp4; codecs="avc1.640015, mp4a.40.2"')
    expect(initMimeType(fixture('init-av1.mp4'))).toBe('video/mp4; codecs="av01.0.01M.08, mp4a.40.2"')
    expect(codecName(initCodecs(fixture('init-hevc.mp4')))).toBe('hevc')
    expect(codecName(initCodecs(fixture('init-h264.mp4')))).toBe('h264')
    expect(codecName(initCodecs(fixture('init-av1.mp4')))).toBe('av1')
  })

  it('handles HEVC profile space, high tier, Main10 compatibility flags, and multiple constraint bytes', () => {
    const hvcC = box('hvcC', bytes(1, 0b01100010, 0x20, 0, 0, 0, 0xb0, 0, 0x01, 0, 0, 0, 153))
    expect(initCodecs(initWith(visual('hev1', hvcC)))).toEqual(['hev1.A2.4.H153.B0.0.1'])
  })

  it('handles AV1 high-tier 10-bit video with no audio track', () => {
    const av1C = box('av1C', bytes(0x81, (1 << 5) | 13, 0b11000000, 0))
    expect(initMimeType(initWith(visual('av01', av1C)))).toBe('video/mp4; codecs="av01.1.13H.10"')
  })

  it('throws on malformed input without reading out of bounds', () => {
    expect(() => initCodecs(new Uint8Array(4))).toThrow('moov')
    const bad = Buffer.from(fixture('init-hevc.mp4'))
    bad.writeUInt32BE(0xffffff, 0)
    expect(() => initCodecs(bad)).toThrow('has an invalid size')
    expect(() => initCodecs(initWith(box('vp09', new Uint8Array(78))))).toThrow('vp09')
    expect(() => initCodecs(initWith(visual('hvc1', box('hvcC', bytes(1, 2)))))).toThrow('hvcC')
    expect(() => initCodecs(initWith(visual('avc1', box('free'))))).toThrow('avcC')
  })
})
