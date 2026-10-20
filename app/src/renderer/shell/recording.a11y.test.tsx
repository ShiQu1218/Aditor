// @vitest-environment jsdom
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { IDLE_RECORDING_STATUS, type RecordingStatus } from '../../shared/recording'
import type { RecordingApi } from '../global'
import { Rail } from './Rail'
import { RecordingPanel } from './RecordingPanel'
import { useRecordingStatus } from './useRecordingStatus'
import { recordingI18n as t } from '../i18n'
import { cleanupMounted, click, flush, focusEl, installDomShims, mount, press } from '../../../test/dom'
import { Providers } from '../../../test/harness'
import { createFakeApi } from '../../../test/fakeApi'

let previousApi: Window['api']
beforeEach(() => { installDomShims(); previousApi = window.api })
afterEach(() => { cleanupMounted(); window.api = previousApi; vi.useRealTimers(); vi.restoreAllMocks() })
function rig(initial: Partial<RecordingStatus> = {}) {
  let current: RecordingStatus = { ...IDLE_RECORDING_STATUS, ...initial }
  const listeners = new Set<(s: RecordingStatus) => void>()
  const api: RecordingApi = {
    getStatus: vi.fn(async () => current), getCapabilities: vi.fn(async () => null),
    startManual: vi.fn(async () => true), stopManual: vi.fn(async () => undefined),
    setPaused: vi.fn(async (paused) => { current = { ...current, paused } }),
    onStatus: (cb) => { listeners.add(cb); return () => listeners.delete(cb) }
  }
  window.api = { ...window.api, recording: api }
  return { api, listeners, emit: (patch: Partial<RecordingStatus>) => { current = { ...current, ...patch }; act(() => listeners.forEach((cb) => cb(current))) } }
}
function button(text: string): HTMLButtonElement {
  return Array.from(document.querySelectorAll('button')).find((el) => el.textContent === text)!
}

describe('Recording rail and panel', () => {
  test('AppShell receives status updates and opens the panel; closing it keeps the rail subscription', async () => {
    window.api = createFakeApi() as unknown as Window['api']
    const r = rig()
    mount(<Providers><div /></Providers>)
    await flush()
    r.emit({ phase: 'recording', startedAt: Date.now() })
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="錄影中"]')!
    expect(trigger.querySelector('.rec-dot')).not.toBeNull()
    focusEl(trigger)
    click(trigger)
    await flush()
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(r.listeners.size).toBe(2)
    press(document.body, 'Escape')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(r.listeners.size).toBe(1)
    expect(document.activeElement).toBe(trigger)
    cleanupMounted()
    expect(r.listeners.size).toBe(0)
  })

  test.each(['idle', 'recording', 'error'] as const)('sidebar name, status dot, and open action for %s', (phase) => {
    const onRecording = vi.fn()
    mount(<Rail active="library" projectCount={0} onNavigate={() => undefined} recordingPhase={phase} onRecording={onRecording} />)
    const label = phase === 'idle' ? t.title : t.phases[phase]
    const trigger = document.querySelector(`[aria-label="${label}"]`)!
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
    expect(trigger.querySelector('.app-icon-video')).not.toBeNull()
    expect(trigger.querySelector('.app-icon-film')).toBeNull()
    expect(trigger.querySelector('.rec-dot') !== null).toBe(phase !== 'idle')
    if (phase === 'error') expect(trigger.querySelector('.rec-dot.error')).not.toBeNull()
    click(trigger)
    expect(onRecording).toHaveBeenCalledOnce()
  })

  test('Status, elapsed time, encoder info, segments, dropped frames, and disk space update; unmount clears subscriptions and timers', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-18T00:01:05Z'))
    const r = rig({ phase: 'recording', startedAt: Date.now() - 65000, encoder: 'hevc_nvenc', width: 2560, height: 1440, segments: 30, droppedFrames: 4, diskFreeBytes: 10 * 1024 ** 3 })
    mount(<RecordingPanel onClose={() => undefined} />)
    await act(async () => undefined)
    expect(document.body.textContent).toContain('00:01:05')
    expect(document.body.textContent).toContain('2560 × 1440')
    expect(document.body.textContent).toContain('hevc_nvenc')
    expect(document.body.textContent).toContain('10.0 GB')
    act(() => vi.advanceTimersByTime(2000))
    expect(document.body.textContent).toContain('00:01:07')
    r.emit({ segments: 31, droppedFrames: 5 })
    expect(document.body.textContent).toContain('段落數31')
    expect(document.body.textContent).toContain('丟格數5')
    cleanupMounted()
    expect(r.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('Manual start/stop and pause; operation failures and service errors are visible', async () => {
    const r = rig()
    mount(<RecordingPanel onClose={() => undefined} />)
    await flush()
    click(button(t.start))
    await flush()
    expect(r.api.startManual).toHaveBeenCalledOnce()
    expect(button(t.stop).disabled).toBe(true)
    r.emit({ phase: 'recording' })
    click(button(t.stop))
    await flush()
    expect(r.api.stopManual).toHaveBeenCalledOnce()
    click(document.querySelector('input[type="checkbox"]')!)
    await flush()
    expect(r.api.setPaused).toHaveBeenCalledWith(true)
    expect((document.querySelector('input') as HTMLInputElement).checked).toBe(true)
    r.emit({ phase: 'idle' })
    r.api.startManual = vi.fn(async () => false)
    click(button(t.start))
    await flush()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(t.apexNotRunning)
    r.api.startManual = vi.fn(async () => { throw new Error('錄影器無法啟動') })
    click(button(t.start))
    await flush()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('錄影器無法啟動')
    cleanupMounted()
    mount(<RecordingPanel onClose={() => undefined} />)
    await flush()
    r.emit({ phase: 'error', error: { code: 'no_hw_encoder', message: '沒有硬體編碼器' } })
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('沒有硬體編碼器')
  })

  test('Named dialog traps focus and returns it to the trigger button after Esc closes it', async () => {
    rig()
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    focusEl(trigger)
    const close = vi.fn()
    const view = mount(<RecordingPanel onClose={close} />)
    await flush()
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe(t.statusTitle)
    expect(dialog.contains(document.activeElement)).toBe(true)
    for (let i = 0; i < 8; i++) { press(document.activeElement!, 'Tab'); expect(dialog.contains(document.activeElement)).toBe(true) }
    press(document.body, 'Escape')
    expect(close).toHaveBeenCalledOnce()
    view.unmount()
    expect(document.activeElement).toBe(trigger)
  })

  test('Shows an error and disables controls when the service is not registered', async () => {
    rig().api.getStatus = async () => { throw new Error('missing handler') }
    mount(<RecordingPanel onClose={() => undefined} />)
    await flush()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(t.serviceUnavailable)
    expect(button(t.start).disabled).toBe(true)
  })

  test('A delayed initial snapshot cannot overwrite newer updates; unmount unsubscribes', async () => {
    const r = rig()
    let resolve!: (s: RecordingStatus) => void
    r.api.getStatus = () => new Promise((done) => { resolve = done })
    function Probe(): JSX.Element { return <span>{useRecordingStatus().status.phase}</span> }
    mount(<Probe />)
    r.emit({ phase: 'recording' })
    await act(async () => resolve(IDLE_RECORDING_STATUS))
    expect(document.body.textContent).toBe('recording')
    cleanupMounted()
    expect(r.listeners.size).toBe(0)
  })
})
