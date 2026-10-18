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

describe('錄影設定畫面與 controller', () => {
  test('完整列順序、label、啟用的一局一個檔及符合格式的編碼器／裝置選項', async () => {
    await show()
    expect(Array.from(document.querySelectorAll<HTMLElement>('[data-row]')).map((el) => el.dataset.row))
      .toEqual(Object.keys(t.rows).map((field) => `recording-${field}`))
    for (const field of Object.keys(t.rows)) {
      const label = document.querySelector(`label[for="set-recording-${field}"]`)
      expect(label?.textContent).toBe(t.rows[field as keyof typeof t.rows].title)
      expect(control(field)?.getAttribute('aria-describedby')).toContain(`set-recording-${field}-desc`)
    }
    const match = control<HTMLSelectElement>('mode').querySelector<HTMLOptionElement>('option[value="match"]')!
    expect(match.disabled).toBe(false)
    expect(match.textContent).toBe('一局一個檔')
    expect(options('encoder')).toEqual(['auto', 'hevc_nvenc'])
    expect(options('renderDevice')).toEqual(['default', 'speakers'])
    expect(options('captureDevice')).toEqual(['default', 'mic'])
    expect(options('height')).toEqual(['0', '1440', '1080', '720'])
    expect(options('fps')).toEqual(['30', '60', '120', '144'])
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
    select('fps', '120')
    select('mode', 'match')
    select('postAnalysis', 'none')
    select('captureMethod', 'dda')
    await flush()
    await number('bitrateKbps', '25')
    await number('micGain', '75')
    expect(r.controller.getState().settings?.recording).toMatchObject({
      autoRecord: false, codec: 'h264', encoder: 'h264_nvenc', renderDevice: 'speakers', captureDevice: 'mic',
      height: 1080, fps: 120, mode: 'match', postAnalysis: 'none', bitrateKbps: 25000, micGain: 0.75, captureMethod: 'dda'
    })
    cleanupMounted()
    mount(<SettingsScreen controller={new SettingsController(r.api)} initialCategory="recording" />)
    await flush()
    expect(control<HTMLInputElement>('autoRecord').checked).toBe(false)
    expect(control<HTMLInputElement>('bitrateKbps').value).toBe('25')
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
    await Promise.all([r.controller.setRecording('fps', 144), r.controller.setRecording('micEnabled', false)])
    expect(r.controller.getState().settings?.recording).toMatchObject({ fps: 144, micEnabled: false })
    r.api.settings.set = async () => { throw new Error('ipc') }
    await r.controller.setRecording('mode', 'match')
    expect(r.controller.getState().settings?.recording.fps).toBe(144)
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
})
