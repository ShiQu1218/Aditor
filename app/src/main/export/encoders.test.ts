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
