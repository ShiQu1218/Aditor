import { describe, expect, it } from 'vitest'
import { playbackPollMs } from './Playhead'

const view = (span: number, width: number) => ({ duration: 600, start: 0, span, width })

describe('playbackPollMs', () => {
  it('waits half a pixel of media time', () => {
    expect(playbackPollMs(view(120, 1000))).toBe(60)
  })

  it('clamps to 16-250 ms and tolerates zero width', () => {
    expect(playbackPollMs(view(5, 1000))).toBe(16)
    expect(playbackPollMs(view(600, 1000))).toBe(250)
    expect(playbackPollMs(view(600, 0))).toBe(250)
  })
})
