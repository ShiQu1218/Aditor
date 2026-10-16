import { describe, it, expect } from 'vitest'
import { parseEncoderList, pickEncoder } from './encoders'

describe('encoders', () => {
  const sampleFfmpegEncodersOutput = `
Encoders:
 V..... = Video
 A..... = Audio
 S..... = Subtitle
 .....D = Direct rendering method
 ...... = None
 ------
 V..... h264_amf             AMD AMF H.264 Encoder (codec h264)
 V..... h264_mf              H264 via MediaFoundation (codec h264)
 V..... h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
 V..... h264_qsv             Intel Quick Sync Video H.264 (codec h264)
 V..... libopenh264          OpenH264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 A..... aac                  AAC (Advanced Audio Coding)
`

  it('parseEncoderList parses video encoders correctly', () => {
    const encoders = parseEncoderList(sampleFfmpegEncodersOutput)
    expect(encoders).toContain('h264_nvenc')
    expect(encoders).toContain('h264_qsv')
    expect(encoders).toContain('h264_amf')
    expect(encoders).toContain('libopenh264')
    expect(encoders).not.toContain('aac')
  })

  it('pickEncoder prioritizes NVENC > QSV > AMF > libopenh264', () => {
    expect(pickEncoder(['libopenh264', 'h264_amf', 'h264_nvenc'])).toBe('h264_nvenc')
    expect(pickEncoder(['libopenh264', 'h264_qsv', 'h264_amf'])).toBe('h264_qsv')
    expect(pickEncoder(['libopenh264', 'h264_amf'])).toBe('h264_amf')
    expect(pickEncoder(['libopenh264'])).toBe('libopenh264')
    expect(pickEncoder([])).toBeNull()
  })
})

import { encoderTestArgs, testEncoder } from './encoders'

describe('hardware encoder probing (I10)', () => {
  it('uses a frame size above NVENC/AMF/QSV minimums (not 16x16)', () => {
    const args = encoderTestArgs('h264_nvenc')
    const src = args[args.indexOf('-i') + 1]
    const m = /s=(\d+)x(\d+)/.exec(src)!
    expect(Number(m[1])).toBeGreaterThanOrEqual(256)
    expect(Number(m[2])).toBeGreaterThanOrEqual(256)
    expect(args).toContain('h264_nvenc')
  })

  it('gives up on a hung driver after the timeout and reports unusable', async () => {
    const t0 = Date.now()
    const ok = await testEncoder(process.execPath, 'h264_nvenc', undefined, { timeoutMs: 300, prefixArgs: ['-e', 'setTimeout(() => {}, 60000)'], args: [] })
    expect(ok).toBe(false)
    expect(Date.now() - t0).toBeLessThan(5000)
  })
})
