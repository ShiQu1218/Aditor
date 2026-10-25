// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanupMounted, mount } from '../../../test/dom'
import { PlaybackControls } from './PlaybackControls'

afterEach(cleanupMounted)

function setup() {
  const calls: string[] = []
  const props = {
    playing: false, currentTime: 5, duration: 100, speed: 1, volume: 1, muted: false, audioDisabled: false,
    onVolumeChange: vi.fn(), onToggleMute: vi.fn(), onTogglePlay: vi.fn(), onCycleSpeed: vi.fn(), onPrevEvent: vi.fn(), onNextEvent: vi.fn(),
    onSeek: vi.fn((t: number) => calls.push(`seek:${t}`)),
    onScrubStart: vi.fn(() => calls.push('start')),
    onScrubEnd: vi.fn((c: boolean) => calls.push(`end:${c}`))
  }
  mount(<PlaybackControls {...props} />)
  const input = document.querySelector<HTMLInputElement>('input.stage-seek')!
  const change = (v: string): void => {
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, v)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const fire = (type: string): void => {
    act(() => { input.dispatchEvent(new Event(type, { bubbles: true })) })
  }
  return { calls, change, fire }
}

describe('PlaybackControls seek bar', () => {
  test('pointer drag wraps seeks in one scrub session', () => {
    const { calls, change, fire } = setup()
    fire('pointerdown')
    change('20')
    change('30')
    fire('pointerup')
    expect(calls).toEqual(['start', 'seek:20', 'seek:30', 'end:false'])
  })

  test('keyboard step without pointerdown is its own scrub session', () => {
    const { calls, change } = setup()
    change('7')
    expect(calls).toEqual(['start', 'seek:7', 'end:false'])
  })
})
