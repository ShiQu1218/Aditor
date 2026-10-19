// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { installPauseOnHide } from './pauseOnHide'

describe('installPauseOnHide', () => {
  it('視窗縮到系統匣時暫停頁面上所有影音；取消訂閱後不再暫停', () => {
    let emitHidden: () => void = () => {}
    const unsubscribe = vi.fn()
    const onHidden = vi.fn((cb: () => void) => { emitHidden = cb; return unsubscribe })
    const video = document.createElement('video')
    const audio = document.createElement('audio')
    document.body.append(video, audio)
    const pauseVideo = vi.spyOn(video, 'pause').mockImplementation(() => {})
    const pauseAudio = vi.spyOn(audio, 'pause').mockImplementation(() => {})

    const off = installPauseOnHide(onHidden, document)
    emitHidden()
    expect(pauseVideo).toHaveBeenCalledTimes(1)
    expect(pauseAudio).toHaveBeenCalledTimes(1)

    off()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
