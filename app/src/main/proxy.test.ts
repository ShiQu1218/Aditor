import { describe, it, expect } from 'vitest'
import { proxyPath, buildProxyArgs, pickEncoder, parseFfmpegProgress } from './proxy'

describe('Proxy generator', () => {
  it('proxyPath generates sha1-based path under proxy dir', () => {
    const p1 = proxyPath('D:/Videos/match1.mp4')
    const p2 = proxyPath('d:\\videos\\match1.mp4')
    expect(p1).toBe(p2)
    expect(p1.endsWith('.mp4')).toBe(true)
  })

  it('buildProxyArgs includes -g 30 and scale=960:540', () => {
    const args = buildProxyArgs('in.mp4', 'out.mp4', 'h264_nvenc')
    expect(args).toContain('-g')
    const gIdx = args.indexOf('-g')
    expect(args[gIdx + 1]).toBe('30')

    const vf = args.find((_, i) => args[i - 1] === '-vf')
    expect(vf).toContain('scale=960:540')
    expect(args).toContain('h264_nvenc')
  })

  it('pickEncoder priority order', () => {
    expect(pickEncoder(['h264_qsv', 'h264_nvenc', 'libopenh264'])).toBe('h264_nvenc')
    expect(pickEncoder(['h264_amf', 'h264_qsv'])).toBe('h264_qsv')
    expect(pickEncoder(['h264_amf', 'libopenh264'])).toBe('h264_amf')
    expect(pickEncoder(['libopenh264'])).toBe('libopenh264')
  })

  it('parseFfmpegProgress reads time= from stderr and clamps to 0..1', () => {
    expect(parseFfmpegProgress('frame= 100 fps=50 time=00:01:30.50 bitrate=1k', 180)).toBeCloseTo(0.5028, 3)
    expect(parseFfmpegProgress('time=00:10:00.00', 60)).toBe(1)
    expect(parseFfmpegProgress('no time here', 60)).toBeNull()
    expect(parseFfmpegProgress('time=00:00:10.00', 0)).toBeNull()
  })
})
