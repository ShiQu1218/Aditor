import { describe, it, expect } from 'vitest'
import { containerCodecSupported, shouldSuggestProxy } from './playability'
import { VideoInfo } from '../../shared/types'

describe('playability', () => {
  it('containerCodecSupported returns false for mkv', () => {
    const info: VideoInfo = {
      path: 'test.mkv',
      size: 100,
      mtime: 1,
      duration: 10,
      width: 1920,
      height: 1080,
      codec: 'h264',
      start_time: 0
    }
    expect(containerCodecSupported(info, 'mkv')).toBe(false)
    expect(containerCodecSupported(info, '.mkv')).toBe(false)
  })

  it('containerCodecSupported returns true for mp4 with h264/av1/vp9/hevc', () => {
    const make = (codec: string): VideoInfo => ({
      path: 'test.mp4',
      size: 100,
      mtime: 1,
      duration: 10,
      width: 1920,
      height: 1080,
      codec,
      start_time: 0
    })

    expect(containerCodecSupported(make('h264'), 'mp4')).toBe(true)
    expect(containerCodecSupported(make('av1'), 'mp4')).toBe(true)
    expect(containerCodecSupported(make('vp9'), 'webm')).toBe(true)
    expect(containerCodecSupported(make('flv'), 'mp4')).toBe(false)
  })

  it('shouldSuggestProxy triggers if not supported, not smooth, or not powerEfficient', () => {
    expect(shouldSuggestProxy({ supported: false, smooth: true, powerEfficient: true })).toBe(true)
    expect(shouldSuggestProxy({ supported: true, smooth: false, powerEfficient: true })).toBe(true)
    expect(shouldSuggestProxy({ supported: true, smooth: true, powerEfficient: false })).toBe(true)
    expect(shouldSuggestProxy({ supported: true, smooth: true, powerEfficient: true })).toBe(false)
  })
})
