// @vitest-environment jsdom
import React, { act } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanupMounted, click, flush, mount } from '../../../test/dom'
import { mountStudio, type StudioMount } from '../../../test/studioHarness'
import { i18n, settingsI18n } from '../i18n'
import { PlayerStage } from './PlayerStage'

let s: StudioMount | null = null
afterEach(() => {
  cleanupMounted()
  s?.restore()
  s = null
})

const video = (): HTMLVideoElement => document.querySelector('video')!
const slider = (): HTMLInputElement => document.querySelector('.preview-volume input')!
const mute = (): HTMLButtonElement => document.querySelector('.preview-volume button')!
function setVolume(value: number): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider(), String(value))
    slider().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

test('restores saved audio, changes actual video volume, and preserves volume when toggling mute', async () => {
  s = await mountStudio({ api: { settings: { previewVolume: 35, previewMuted: true } } })
  expect(video().volume).toBe(0.35)
  expect(video().muted).toBe(true)
  expect(slider().value).toBe('35')
  expect(mute().getAttribute('aria-label')).toBe(i18n.studio.transport.unmute)
  click(mute())
  expect(video().muted).toBe(false)
  setVolume(60)
  expect(video().volume).toBe(0.6)
  expect(slider().getAttribute('aria-valuetext')).toBe('60%')
  click(mute())
  expect(video().muted).toBe(true)
  expect(video().volume).toBe(0.6)
  click(mute())
  expect(video().muted).toBe(false)
  setVolume(0)
  expect(video().volume).toBe(0)
  click(mute())
  expect(video().volume).toBe(1)
  await flush()
  expect(s.fake.api.settings.set).toHaveBeenLastCalledWith({ previewVolume: 100, previewMuted: false })

  setVolume(42)
  click(mute())
  await flush()
  const saved = await s.fake.api.settings.get()
  cleanupMounted()
  s.restore()
  s = await mountStudio({ api: { settings: saved } })
  expect(video().volume).toBe(0.42)
  expect(video().muted).toBe(true)
})

test.each(['disk', 'ipc'])('surfaces %s save failures while applying audio immediately', async (kind) => {
  s = await mountStudio()
  if (kind === 'disk') {
    s.fake.api.settings.set.mockImplementationOnce(async () => ({ settings: await s!.fake.api.settings.get(), persisted: false }))
  } else {
    s.fake.api.settings.set.mockRejectedValueOnce(new Error('IPC failed'))
  }
  setVolume(25)
  await flush()
  expect(video().volume).toBe(0.25)
  expect(document.querySelector('.toast')?.textContent).toContain(settingsI18n.saveFailed)
})

test('keeps preview audio applied when changing video sources', () => {
  const videoRef = React.createRef<HTMLVideoElement>()
  const props = {
    videoRef, volume: 20, muted: true, mode: 'source' as const, modeLabel: '', spectating: false, recentCounted: 0,
    onTogglePlay: vi.fn(), onTimeUpdate: vi.fn(), onLoadedMetadata: vi.fn(), onPlayingChange: vi.fn(), onEnded: vi.fn(), onError: vi.fn()
  }
  const m = mount(<PlayerStage {...props} src="first.mp4" />)
  act(() => m.root.render(<PlayerStage {...props} src="second.mp4" />))
  expect(videoRef.current!.volume).toBe(0.2)
  expect(videoRef.current!.muted).toBe(true)
})
