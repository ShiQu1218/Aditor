// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { SettingsScreen } from './SettingsScreen'
import { SettingsController, type SettingsApi } from './settingsController'
import { DEFAULT_SETTINGS, type Settings } from '../../shared/settings'
import type { RecorderCapabilities } from '../../shared/recording'
import { recordingI18n as t } from '../i18n'
import { cleanupMounted, click, flush, installDomShims, mount, press } from '../../../test/dom'

const capabilities: RecorderCapabilities = {
  version: '0.1.0', encoders: ['hevc_nvenc', 'h264_nvenc', 'av1_qsv'],
  gpus: [
    { id: '10de:2684', name: 'NVIDIA GeForce RTX 5080', vendor: 'nvidia', encoders: ['hevc_nvenc', 'h264_nvenc'] },
    { id: '8086:46a6', name: 'Intel Iris Xe Graphics', vendor: 'intel', encoders: ['av1_qsv'] }
  ],
  audio: { render: [{ id: 'speakers', name: '喇叭', default: true }], capture: [{ id: 'mic', name: '桌上型麥克風', default: true }] }
}

function rig(caps: RecorderCapabilities | null = capabilities) {
  let current = structuredClone(DEFAULT_SETTINGS)
  const listeners = new Set<(s: Settings) => void>()
  const set = vi.fn(async (partial: Partial<Settings>) => {
    current = { ...current, ...partial }
    return { settings: current, persisted: true }
  })
  const api: SettingsApi = {
    settings: { get: async () => current, set, onChanged: (cb) => { listeners.add(cb); return () => listeners.delete(cb) } },
    recording: { getCapabilities: vi.fn(async () => caps) },
    export: { selectOutDir: vi.fn(async () => 'D:/Recordings'), detectEncoders: async () => [], openh264Status: async () => ({ installed: false }) }
  }
  const controller = new SettingsController(api)
  return { api, controller, set, listeners, emit: (settings: Settings) => listeners.forEach((cb) => cb(settings)) }
}
beforeEach(() => installDomShims())
afterEach(() => { cleanupMounted(); vi.restoreAllMocks(); vi.useRealTimers() })
const control = <T extends HTMLElement>(field: string): T => document.getElementById(`set-recording-${field}`) as T
const options = (field: string): string[] => Array.from(control<HTMLSelectElement>(field).options).map((o) => o.value)
async function show(caps: RecorderCapabilities | null = capabilities) {
  const r = rig(caps)
  mount(<SettingsScreen controller={r.controller} initialCategory="recording" />)
  await flush()
  return r
}
function select(field: string, value: string): void {
  const el = control<HTMLSelectElement>(field)
  act(() => { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })) })
}
async function number(field: string, value: string): Promise<void> {
  const el = control<HTMLInputElement>(field)
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  await flush()
}

async function slider(field: string, value: string): Promise<void> {
  const el = control<HTMLInputElement>(field)
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
  act(() => { el.dispatchEvent(new Event('pointerup', { bubbles: true })) })
  await flush()
}

describe('Recording settings screen and controller', () => {
  test('cursor recording defaults on and can be disabled in saved settings', async () => {
    const r = await show()
    expect(control<HTMLInputElement>('captureCursor').checked).toBe(true)
    click(control('captureCursor'))
    await flush()
    expect(r.controller.getState().settings?.recording.captureCursor).toBe(false)
    expect(r.set).toHaveBeenLastCalledWith(expect.objectContaining({ recording: expect.objectContaining({ captureCursor: false }) }))
  })
  test('Selecting OBS shows connection settings, hides video/audio settings, preserves values on remount, and shows the test result', async () => {
    const r = await show()
    r.api.recording!.testObs = vi.fn(async () => ({ ok: true as const, obsVersion: '31.0.0', obsWebSocketVersion: '5.5.0' }))
    select('backend', 'obs')
    await flush()
    expect(control('obsHost')).not.toBeNull()
    expect(control('obsPort')).not.toBeNull()
    expect(control('obsPassword')).not.toBeNull()
    expect(control('encoder')).toBeNull()
    expect(control('micEnabled')).toBeNull()
    expect(control('captureMethod')).not.toBeNull()
    expect(document.body.textContent).toContain('品質與音訊請在 OBS 設定')
    expect(document.body.textContent).toContain('工具 → WebSocket 伺服器設定')
    const host = control<HTMLInputElement>('obsHost')
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(host, 'localhost')
      host.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => { host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await number('obsPort', '5555')
    click(control('obsFallbackBuiltin'))
    await flush()
    click(Array.from(document.querySelectorAll('button')).find((el) => el.textContent === '測試連線')!)
    await flush()
    expect(document.body.textContent).toContain('OBS 31.0.0')
    expect(document.body.textContent).toContain('5.5.0')
    cleanupMounted()
    mount(<SettingsScreen controller={new SettingsController(r.api)} initialCategory="recording" />)
    await flush()
    expect(control<HTMLSelectElement>('backend').value).toBe('obs')
    expect(control<HTMLInputElement>('obsHost').value).toBe('localhost')
    expect(control<HTMLInputElement>('obsPort').value).toBe('5555')
    expect(control<HTMLInputElement>('obsFallbackBuiltin').checked).toBe(false)
    expect(control<HTMLInputElement>('obsPassword').value).toBe('')
    r.api.recording!.testObs = vi.fn(async () => ({ ok: false as const, error: 'OBS 密碼驗證失敗' }))
    click(Array.from(document.querySelectorAll('button')).find((el) => el.textContent === '測試連線')!)
    await flush()
    expect(document.body.textContent).toContain('OBS 密碼驗證失敗')
  })

  test('OBS password is write-only, save errors are shown, and an existing password is not filled back in', async () => {
    const r = await show()
    select('backend', 'obs'); await flush()
    r.set.mockImplementationOnce(async () => ({ settings: r.controller.getState().settings!, persisted: true, errors: { obsPassword: '加密服務無法使用' } }))
    const password = control<HTMLInputElement>('obsPassword')
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(password, '秘密')
      password.dispatchEvent(new Event('input', { bubbles: true }))
    })
    click(Array.from(document.querySelectorAll('button')).find((el) => el.textContent === '儲存密碼')!)
    await flush()
    expect(document.body.textContent).toContain('加密服務無法使用')
    act(() => r.emit({ ...r.controller.getState().settings!, recording: { ...r.controller.getState().settings!.recording, hasPassword: true } }))
    await flush()
    expect(control<HTMLInputElement>('obsPassword').value).toBe('')
    expect(control<HTMLInputElement>('obsPassword').placeholder).toBe('已設定')
  })

  test('Full row order and labels, enabled one-file-per-match, and encoder/device options matching the selected format', async () => {
    await show()
    // Launch-at-login and minimize-to-tray are app-wide settings under General; OBS rows appear only for the OBS backend.
    const fields = [
      'autoRecord', 'mode', 'postAnalysis',
      'backend',
      'height', 'bitrateKbps', 'fps', 'captureCursor', 'forceAspect', 'aspectMode', 'codec', 'gpu', 'encoder', 'preset', 'captureMethod',
      'systemAudioEnabled', 'renderDevice', 'systemGain', 'micEnabled', 'captureDevice', 'micGain', 'gameAudioOnly', 'micMono',
      'diskWarnGb', 'diskStopGb', 'notifyMatch', 'openOnGameExit'
    ]
    expect(Array.from(document.querySelectorAll<HTMLElement>('[data-row]')).map((el) => el.dataset.row))
      .toEqual(fields.map((field) => `recording-${field}`))
    expect(Array.from(document.querySelectorAll('.set-card h2')).map((el) => el.textContent))
      .toEqual([t.cards.basics, t.cards.recorder, t.cards.video, t.cards.audio, t.cards.disk])
    for (const field of fields) {
      const label = document.getElementById(`set-recording-${field}-title`)
      expect(label?.textContent).toBe(t.rows[field as keyof typeof t.rows].title)
      expect(control(field)?.getAttribute('aria-describedby')).toContain(`set-recording-${field}-desc`)
    }
    const match = control<HTMLSelectElement>('mode').querySelector<HTMLOptionElement>('option[value="match"]')!
    expect(match.disabled).toBe(false)
    expect(match.textContent).toBe('一局一個檔')
    expect(options('encoder')).toEqual(['auto', 'hevc_nvenc'])
    expect(options('gpu')).toEqual(['auto', '10de:2684', '8086:46a6'])
    expect(options('renderDevice')).toEqual(['default', 'speakers'])
    expect(options('captureDevice')).toEqual(['default', 'mic'])
    expect(options('height')).toEqual(['0', '720', '1080', '1440'])
    expect(Array.from(control('fps').querySelectorAll('input')).map((el) => el.value)).toEqual(['10', '20', '30', '60', '90', '120'])
    expect(options('captureMethod')).toEqual(['auto', 'wgc', 'dda', 'hook'])
  })

  test('Toggles, format, device, and numeric units are submitted and updated from the result; values persist after remount', async () => {
    const r = await show()
    click(control('autoRecord'))
    await flush()
    expect(r.controller.getState().settings?.recording.autoRecord).toBe(false)
    select('codec', 'h264')
    await flush()
    expect(options('encoder')).toEqual(['auto', 'h264_nvenc'])
    select('encoder', 'h264_nvenc')
    select('renderDevice', 'speakers')
    select('captureDevice', 'mic')
    select('height', '1080')
    click(control('fps').querySelector('input[value="120"]')!)
    select('mode', 'match')
    select('postAnalysis', 'none')
    select('captureMethod', 'dda')
    await flush()
    select('bitrateKbps', '30000')
    await flush()
    await slider('micGain', '75')
    expect(r.controller.getState().settings?.recording).toMatchObject({
      autoRecord: false, codec: 'h264', encoder: 'h264_nvenc', renderDevice: 'speakers', captureDevice: 'mic',
      height: 1080, fps: 120, mode: 'match', postAnalysis: 'none', bitrateKbps: 30000, micGain: 0.75, captureMethod: 'dda'
    })
    cleanupMounted()
    mount(<SettingsScreen controller={new SettingsController(r.api)} initialCategory="recording" />)
    await flush()
    expect(control<HTMLInputElement>('autoRecord').checked).toBe(false)
    expect(control<HTMLInputElement>('bitrateKbps').value).toBe('30000')
    expect(control<HTMLSelectElement>('encoder').value).toBe('h264_nvenc')
    expect(control<HTMLSelectElement>('mode').value).toBe('match')
  })

  test('Recording tab has no separate recording-folder row (configured centrally under Storage location)', async () => {
    await show()
    expect(document.querySelector('[data-row="recording-outputDir"]')).toBeNull()
  })

  test('When capabilities are null or loading fails, shows only default options and a notice without submitting settings', async () => {
    const r = await show(null)
    expect(options('encoder')).toEqual(['auto'])
    expect(options('gpu')).toEqual(['auto'])
    expect(options('renderDevice')).toEqual(['default'])
    expect(options('captureDevice')).toEqual(['default'])
    expect(document.body.textContent).toContain(t.capabilitiesUnavailable)
    expect(r.set).not.toHaveBeenCalled()
    r.api.recording!.getCapabilities = async () => { throw new Error('missing') }
    await act(() => r.controller.refreshRecordingCapabilities())
    expect(r.controller.getState().recordingCapabilities.value).toBeNull()
    const saved = { ...structuredClone(DEFAULT_SETTINGS), recording: { ...DEFAULT_SETTINGS.recording, captureDevice: 'offline-device', encoder: 'hevc_nvenc' } }
    act(() => r.emit(saved))
    expect(control<HTMLSelectElement>('captureDevice').value).toBe('offline-device')
    expect(control<HTMLSelectElement>('encoder').value).toBe('hevc_nvenc')
    expect(r.set).not.toHaveBeenCalled()
  })

  test('Rapid setting changes use the latest returned snapshot; IPC failure reloads state and unsubscribes', async () => {
    const r = rig()
    await r.controller.start()
    await Promise.all([r.controller.setRecording('fps', 90), r.controller.setRecording('micEnabled', false)])
    expect(r.controller.getState().settings?.recording).toMatchObject({ fps: 90, micEnabled: false })
    r.api.settings.set = async () => { throw new Error('ipc') }
    await r.controller.setRecording('mode', 'match')
    expect(r.controller.getState().settings?.recording.fps).toBe(90)
    expect(r.controller.getState().settings?.recording.mode).toBe('session')
    expect(r.controller.getState().saveFailed).toBe(true)
    r.controller.stop()
    expect(r.listeners.size).toBe(0)
  })

  test('Search finds the recording category and shows the match count', async () => {
    const r = rig()
    mount(<SettingsScreen controller={r.controller} initialQuery="麥克風" />)
    await flush()
    expect(document.querySelector('[data-row="recording-micGain"]')).not.toBeNull()
    expect(document.querySelector('#set-tab-recording .set-hit')).not.toBeNull()
  })
  test('Advanced settings are collapsed by default and expand on search; bitrate preserves custom values and audio-source disabled state', async () => {
    const r = await show()
    const sections = Array.from(document.querySelectorAll('details'))
    expect(sections).toHaveLength(2)
    expect(sections.every((el) => !el.open)).toBe(true)
    expect(options('bitrateKbps')).toEqual(['5000', '8000', '10000', '15000', '20000', '30000', '40000', '50000', '60000', '80000', '100000', '150000'])
    expect(Array.from(control('aspectMode').querySelectorAll('input')).every((el) => el.disabled)).toBe(true)
    click(control('forceAspect'))
    await flush()
    expect(Array.from(control('aspectMode').querySelectorAll('input')).every((el) => !el.disabled)).toBe(true)
    click(control('aspectMode').querySelector('input[value="stretch"]')!)
    select('preset', 'quality')
    click(control('gameAudioOnly'))
    await flush()
    expect(control<HTMLSelectElement>('renderDevice').disabled).toBe(true)
    click(control('gameAudioOnly'))
    click(control('systemAudioEnabled'))
    click(control('micEnabled'))
    await flush()
    for (const field of ['renderDevice', 'systemGain', 'captureDevice', 'micGain']) expect(control<HTMLInputElement>(field).disabled).toBe(true)
    expect(r.controller.getState().settings?.recording).toMatchObject({ forceAspect: true, aspectMode: 'stretch', preset: 'quality' })
    r.set.mockClear()
    act(() => r.emit({ ...structuredClone(DEFAULT_SETTINGS), recording: { ...DEFAULT_SETTINGS.recording, bitrateKbps: 23456 } }))
    expect(control<HTMLSelectElement>('bitrateKbps').selectedOptions[0].textContent).toBe('目前：23456')
    expect(r.set).not.toHaveBeenCalled()
    cleanupMounted()
    mount(<SettingsScreen controller={new SettingsController(r.api)} initialQuery="只錄遊戲" />)
    await flush()
    expect(control('gameAudioOnly')).not.toBeNull()
    expect(document.querySelector('details')?.open).toBe(true)
  })

  test('Recording GPU selection filters encoders and a missing saved GPU displays as automatic', async () => {
    const r = await show()
    expect(options('gpu')).toEqual(['auto', '10de:2684', '8086:46a6'])
    select('gpu', '10de:2684')
    await flush()
    expect(r.controller.getState().settings?.recording.gpu).toBe('10de:2684')
    expect(options('encoder')).toEqual(['auto', 'hevc_nvenc'])
    select('codec', 'h264')
    await flush()
    expect(options('encoder')).toEqual(['auto', 'h264_nvenc'])
    select('gpu', '8086:46a6')
    await flush()
    expect(options('encoder')).toEqual(['auto'])
    select('codec', 'av1')
    await flush()
    expect(options('encoder')).toEqual(['auto', 'av1_qsv'])
    const saved = { ...structuredClone(DEFAULT_SETTINGS), recording: { ...DEFAULT_SETTINGS.recording, gpu: 'dead:beef', encoder: 'hevc_nvenc' } }
    act(() => r.emit(saved))
    await flush()
    expect(control<HTMLSelectElement>('gpu').value).toBe('auto')
    expect(options('encoder')).toEqual(['auto', 'hevc_nvenc'])
    r.set.mockClear()
    expect(r.set).not.toHaveBeenCalled()
  })

  test('Changing the GPU resets an incompatible encoder but keeps compatible and automatic selections', async () => {
    const r = await show()
    select('encoder', 'hevc_nvenc')
    await flush()
    // The newly selected GPU still supports the saved encoder, so it is kept.
    select('gpu', '10de:2684')
    await flush()
    expect(r.controller.getState().settings?.recording).toMatchObject({ gpu: '10de:2684', encoder: 'hevc_nvenc' })
    // The new GPU does not support the saved encoder, so it resets to automatic.
    select('gpu', '8086:46a6')
    await flush()
    expect(r.controller.getState().settings?.recording).toMatchObject({ gpu: '8086:46a6', encoder: 'auto' })
    // Selecting the automatic GPU keeps an explicit encoder.
    select('gpu', '10de:2684')
    await flush()
    select('encoder', 'hevc_nvenc')
    await flush()
    select('gpu', 'auto')
    await flush()
    expect(r.controller.getState().settings?.recording).toMatchObject({ gpu: 'auto', encoder: 'hevc_nvenc' })
  })

  test('Screen capture disables the GPU picker and lists encoders from the global capabilities', async () => {
    const r = await show()
    const saved: Settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      recording: { ...DEFAULT_SETTINGS.recording, captureMethod: 'dda', gpu: '8086:46a6', codec: 'hevc' }
    }
    act(() => r.emit(saved))
    await flush()
    // DDA ignores the saved GPU, so the picker is disabled and the saved value is kept.
    expect(control<HTMLSelectElement>('gpu').disabled).toBe(true)
    expect(control<HTMLSelectElement>('gpu').value).toBe('8086:46a6')
    expect(options('encoder')).toEqual(['auto', 'hevc_nvenc'])
    expect(r.set).not.toHaveBeenCalled()

    // Window capture re-enables the picker and filters encoders by the saved GPU as before.
    select('captureMethod', 'wgc')
    await flush()
    expect(control<HTMLSelectElement>('gpu').disabled).toBe(false)
    expect(control<HTMLSelectElement>('gpu').value).toBe('8086:46a6')
    expect(options('encoder')).toEqual(['auto'])
    expect(r.controller.getState().settings?.recording).toMatchObject({ captureMethod: 'wgc', gpu: '8086:46a6' })
  })

  test('Automatic capture disables the GPU picker only where it resolves to screen capture', async () => {
    const saved: Settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      recording: { ...DEFAULT_SETTINGS.recording, captureMethod: 'auto', gpu: '8086:46a6', codec: 'hevc' }
    }
    const win10 = await show({ ...capabilities, autoCaptureMethod: 'dda' })
    act(() => win10.emit(saved))
    await flush()
    expect(control<HTMLSelectElement>('gpu').disabled).toBe(true)
    expect(options('encoder')).toEqual(['auto', 'hevc_nvenc'])
    cleanupMounted()

    const win11 = await show({ ...capabilities, autoCaptureMethod: 'wgc' })
    act(() => win11.emit(saved))
    await flush()
    expect(control<HTMLSelectElement>('gpu').disabled).toBe(false)
    expect(options('encoder')).toEqual(['auto'])
  })

  test('Capture selection persists after remount and surfaces save failures', async () => {
    const r = await show()
    expect(options('captureMethod')).toEqual(['auto', 'wgc', 'dda', 'hook'])
    select('captureMethod', 'dda')
    await flush()
    expect(r.controller.getState().settings?.recording.captureMethod).toBe('dda')
    cleanupMounted()
    const reloaded = new SettingsController(r.api)
    mount(<SettingsScreen controller={reloaded} initialCategory="recording" />)
    await flush()
    expect(control<HTMLSelectElement>('captureMethod').value).toBe('dda')
    r.set.mockRejectedValueOnce(new Error('disk unavailable'))
    select('captureMethod', 'wgc')
    await flush()
    expect(control<HTMLSelectElement>('captureMethod').value).toBe('dda')
    expect(reloaded.getState().saveFailed).toBe(true)
    expect(document.querySelector('.set-notice')).not.toBeNull()
  })
  test('Switching to game capture opens a 5-second warning dialog: confirm is disabled during countdown and applies hook afterward; switching away from hook has no warning', async () => {
    const r = await show()
    const details = control('captureMethod').closest('details')!
    details.open = true
    expect(control<HTMLSelectElement>('captureMethod').value).toBe('auto')

    vi.useFakeTimers()
    select('captureMethod', 'hook')

    const dlg = document.querySelector<HTMLElement>('[role="alertdialog"]')!
    expect(dlg).not.toBeNull()
    expect(dlg.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(dlg.getAttribute('aria-labelledby')!)?.textContent).toBe('使用 Hook擷取前請注意')
    const descEl = document.getElementById(dlg.getAttribute('aria-describedby')!)!
    expect(descEl.classList.contains('set-dlg-body')).toBe(true)
    expect(descEl.tabIndex).toBe(0)
    expect(Array.from(descEl.querySelectorAll('h4')).map((el) => el.textContent)).toEqual([
      'Hook擷取與視窗擷取（WGC）的差別',
      '運作原理',
      '風險',
      '聲明'
    ])
    expect(descEl.textContent).toContain('graphics-hook')
    expect(descEl.textContent).toContain('反作弊系統')
    expect(r.controller.getState().settings?.recording.captureMethod).toBe('auto')
    expect(control<HTMLSelectElement>('captureMethod').value).toBe('auto')
    expect(r.set).not.toHaveBeenCalled()

    const cancelBtn = document.getElementById('set-recording-captureHook-cancel') as HTMLButtonElement
    const confirmBtn = document.getElementById('set-recording-captureHook-confirm') as HTMLButtonElement
    expect(document.activeElement).toBe(cancelBtn)
    expect(confirmBtn.disabled).toBe(true)
    expect(confirmBtn.textContent).toBe('確認（5）')

    // Click, Enter, and Space cannot confirm during the countdown.
    click(confirmBtn)
    act(() => {
      confirmBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      confirmBtn.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    })
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()
    expect(r.controller.getState().settings?.recording.captureMethod).toBe('auto')

    // The button remains disabled through the countdown to 4 seconds.
    for (const expected of ['確認（4）', '確認（3）', '確認（2）', '確認（1）']) {
      act(() => { vi.advanceTimersByTime(1000) })
      expect(confirmBtn.disabled).toBe(true)
      expect(confirmBtn.textContent).toBe(expected)
    }
    click(confirmBtn)
    expect(r.controller.getState().settings?.recording.captureMethod).toBe('auto')

    // Enable the button and show "Confirm" after 5 seconds.
    act(() => { vi.advanceTimersByTime(1000) })
    expect(confirmBtn.disabled).toBe(false)
    expect(confirmBtn.textContent).toBe('確認')

    vi.useRealTimers()
    click(confirmBtn)
    await flush()
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    expect(r.controller.getState().settings?.recording.captureMethod).toBe('hook')
    expect(control<HTMLSelectElement>('captureMethod').value).toBe('hook')
    expect(control<HTMLSelectElement>('captureMethod').querySelector('option[value="hook"]')?.textContent).toBe('Hook擷取（高效率）')
    expect(control<HTMLInputElement>('captureCursor').disabled).toBe(true)
    expect(control<HTMLInputElement>('captureCursor').checked).toBe(false)
    expect(r.controller.getState().settings?.recording.captureCursor).toBe(true)
    expect(document.activeElement).toBe(control('captureMethod'))

    // Selecting hook again while already using hook does not open the dialog.
    select('captureMethod', 'hook')
    await flush()
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()

    // Switching from hook to another method applies immediately without opening the dialog.
    select('captureMethod', 'dda')
    await flush()
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    expect(r.controller.getState().settings?.recording.captureMethod).toBe('dda')
    expect(control<HTMLInputElement>('captureCursor').disabled).toBe(false)
    expect(control<HTMLInputElement>('captureCursor').checked).toBe(true)

    // Switching back to hook still opens the dialog; confirmation is not remembered.
    select('captureMethod', 'hook')
    await flush()
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()
  })

  test('Game-capture warning: cancel, Esc, and outside click preserve the value and restore focus to the selector; Tab focus stays trapped', async () => {
    const r = await show()
    const selectEl = control<HTMLSelectElement>('captureMethod')
    selectEl.closest('details')!.open = true
    select('captureMethod', 'dda')
    await flush()
    r.set.mockClear()

    // 1. Click Cancel.
    select('captureMethod', 'hook')
    await flush()
    const cancelBtn = document.getElementById('set-recording-captureHook-cancel') as HTMLButtonElement
    const bodyEl = document.getElementById('set-capture-hook-warn-desc') as HTMLElement
    expect(document.activeElement).toBe(cancelBtn)

    // Keep Tab focus inside the dialog; with Confirm disabled, cycle between the scrollable body and Cancel.
    press(cancelBtn, 'Tab')
    expect(document.activeElement).toBe(bodyEl)
    press(bodyEl, 'Tab')
    expect(document.activeElement).toBe(cancelBtn)

    click(cancelBtn)
    await flush()
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    expect(r.controller.getState().settings?.recording.captureMethod).toBe('dda')
    expect(selectEl.value).toBe('dda')
    expect(r.set).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(selectEl)

    // 2. Press Escape.
    select('captureMethod', 'hook')
    await flush()
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()
    press(document.activeElement!, 'Escape')
    await flush()
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    expect(r.controller.getState().settings?.recording.captureMethod).toBe('dda')
    expect(selectEl.value).toBe('dda')
    expect(r.set).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(selectEl)

    // 3. Click the backdrop outside the dialog.
    select('captureMethod', 'hook')
    await flush()
    const scrim = document.querySelector<HTMLElement>('.set-dlg-scrim')!
    click(scrim)
    await flush()
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    expect(r.controller.getState().settings?.recording.captureMethod).toBe('dda')
    expect(selectEl.value).toBe('dda')
    expect(document.activeElement).toBe(selectEl)
  })

})

