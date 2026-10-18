// @vitest-environment jsdom
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { SettingsScreen } from './SettingsScreen'
import { SettingsController, type SettingsApi } from './settingsController'
import { DEFAULT_SETTINGS, type Settings } from '../../shared/settings'
import type { RecorderCapabilities } from '../../shared/recording'
import { recordingI18n as t } from '../i18n/zh-TW'
import { cleanupMounted, click, flush, installDomShims, mount } from '../../../test/dom'

const capabilities: RecorderCapabilities = {
  version: '0.1.0', encoders: ['hevc_nvenc', 'h264_nvenc', 'av1_qsv'],
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
afterEach(() => { cleanupMounted(); vi.restoreAllMocks() })
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

describe('錄影設定畫面與 controller', () => {
  test('選擇 OBS 後顯示連線設定、隱藏影像音訊設定，重掛保留並顯示測試結果', async () => {
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

  test('OBS 密碼為唯寫欄位，儲存錯誤會顯示，已設定狀態不回填密碼', async () => {
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

  test('完整列順序、label、啟用的一局一個檔及符合格式的編碼器／裝置選項', async () => {
    await show()
    expect(Array.from(document.querySelectorAll<HTMLElement>('[data-row]')).map((el) => el.dataset.row))
      .toEqual(Object.keys(t.rows).filter((field) => !field.startsWith('obs')).map((field) => `recording-${field}`))
    for (const field of Object.keys(t.rows).filter((field) => !field.startsWith('obs'))) {
      const label = document.getElementById(`set-recording-${field}-title`)
      expect(label?.textContent).toBe(t.rows[field as keyof typeof t.rows].title)
      expect(control(field)?.getAttribute('aria-describedby')).toContain(`set-recording-${field}-desc`)
    }
    const match = control<HTMLSelectElement>('mode').querySelector<HTMLOptionElement>('option[value="match"]')!
    expect(match.disabled).toBe(false)
    expect(match.textContent).toBe('一局一個檔')
    expect(options('encoder')).toEqual(['auto', 'hevc_nvenc'])
    expect(options('renderDevice')).toEqual(['default', 'speakers'])
    expect(options('captureDevice')).toEqual(['default', 'mic'])
    expect(options('height')).toEqual(['0', '720', '1080', '1440'])
    expect(Array.from(control('fps').querySelectorAll('input')).map((el) => el.value)).toEqual(['10', '20', '30', '60', '90', '120'])
    expect(options('captureMethod')).toEqual(['wgc', 'dda'])
  })

  test('開關、格式、裝置及數值單位會送出並同步回傳結果，重新掛載保留值', async () => {
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

  test('資料夾選擇與清除、取消不送出；路徑與儲存失敗正確顯示', async () => {
    const r = await show()
    click(control('outputDir'))
    await flush()
    expect(r.controller.getState().settings?.recording.outputDir).toBe('D:/Recordings')
    const clear = Array.from(document.querySelectorAll('button')).find((el) => el.textContent === t.clear)!
    click(clear)
    await flush()
    expect(r.controller.getState().settings?.recording.outputDir).toBeNull()
    r.api.export!.selectOutDir = async () => null
    r.set.mockClear()
    click(control('outputDir'))
    await flush()
    expect(r.set).not.toHaveBeenCalled()
    r.api.export!.selectOutDir = async () => 'D:/missing'
    r.api.settings.set = async () => ({ settings: structuredClone(DEFAULT_SETTINGS), persisted: false, errors: { recordingOutputDir: '資料夾不存在' } })
    click(control('outputDir'))
    await flush()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('資料夾不存在')
    expect(control('outputDir').getAttribute('aria-describedby')).toContain('set-recording-outputDir-err')
    expect(document.body.textContent).toContain('儲存失敗')
    expect(r.controller.getState().settings?.recording.outputDir).toBeNull()
    r.api.settings.set = async () => ({ settings: structuredClone(DEFAULT_SETTINGS), persisted: true })
    click(control('outputDir'))
    await flush()
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(document.body.textContent).not.toContain('儲存失敗')
  })

  test('capabilities=null 或查詢失敗只顯示預設選項與提示，不送出設定', async () => {
    const r = await show(null)
    expect(options('encoder')).toEqual(['auto'])
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

  test('連續設定操作以最新回傳快照為準；IPC 失敗重新讀取並解除訂閱', async () => {
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

  test('搜尋可找到錄影分類並顯示命中數', async () => {
    const r = rig()
    mount(<SettingsScreen controller={r.controller} initialQuery="麥克風" />)
    await flush()
    expect(document.querySelector('[data-row="recording-micGain"]')).not.toBeNull()
    expect(document.querySelector('#set-tab-recording .set-hit')).not.toBeNull()
  })
  test('進階預設收合、搜尋自動展開，位元率保留清單外值及音源停用狀態', async () => {
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

})
