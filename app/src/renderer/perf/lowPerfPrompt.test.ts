import { describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { i18n } from '../i18n'
import { PROBE_CONFIG, createLowPerfPrompt, lacksHardwareDecode } from './lowPerfPrompt'

const mc = (info: { supported: boolean; smooth: boolean; powerEfficient: boolean } | Error) => ({
  decodingInfo: vi.fn(async () => {
    if (info instanceof Error) throw info
    return info
  })
})
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('lacksHardwareDecode (pure decision logic)', () => {
  test('Probes 1080p60 H.264', () => {
    expect(PROBE_CONFIG.video).toMatchObject({ width: 1920, height: 1080, framerate: 60 })
    expect(PROBE_CONFIG.video.contentType).toMatch(/avc1/)
  })
  test('Unsupported, smoothness unavailable, or not power-efficient (no hardware decode) → true; smooth and power-efficient → false', async () => {
    expect(await lacksHardwareDecode(mc({ supported: true, smooth: true, powerEfficient: true }))).toBe(false)
    expect(await lacksHardwareDecode(mc({ supported: true, smooth: true, powerEfficient: false }))).toBe(true)
    expect(await lacksHardwareDecode(mc({ supported: true, smooth: false, powerEfficient: true }))).toBe(true)
    expect(await lacksHardwareDecode(mc({ supported: false, smooth: false, powerEfficient: false }))).toBe(true)
  })
  test('Missing API or an exception → false (do not bother the user)', async () => {
    expect(await lacksHardwareDecode(undefined)).toBe(false)
    expect(await lacksHardwareDecode(mc(new Error('x')))).toBe(false)
  })
})

function setup(settings = {}, hw = { supported: true, smooth: false, powerEfficient: false }) {
  const state = { ...DEFAULT_SETTINGS, ...settings }
  const set = vi.fn(async (p: Partial<typeof state>) => void Object.assign(state, p))
  const seen: boolean[] = []
  const prompt = createLowPerfPrompt(
    { getSettings: async () => state, setSettings: set, mediaCapabilities: mc(hw) },
    (visible) => seen.push(visible)
  )
  return { state, set, seen, prompt }
}

describe('First-launch low-performance prompt', () => {
  test('Without hardware decoding and not asked before → show and immediately set lowPerfAsked (ask once)', async () => {
    const { prompt, set, seen } = setup()
    await prompt.start()
    expect(seen.at(-1)).toBe(true)
    expect(set).toHaveBeenCalledWith({ lowPerfAsked: true })
    // Do not show the prompt on the next launch (lowPerfAsked is now true).
    const next = setup({ lowPerfAsked: true })
    await next.prompt.start()
    expect(next.seen).toEqual([])
  })
  test('With hardware decoding → do not show or write settings', async () => {
    const { prompt, set, seen } = setup({}, { supported: true, smooth: true, powerEfficient: true })
    await prompt.start()
    expect(seen).toEqual([])
    expect(set).not.toHaveBeenCalled()
  })
  test('When low-performance mode is already enabled → do not show', async () => {
    const { prompt, seen } = setup({ lowPerfMode: true })
    await prompt.start()
    expect(seen).toEqual([])
  })
  test('Enable → set lowPerfMode:true and close the notice; Dismiss → only close the notice', async () => {
    const a = setup()
    await a.prompt.start()
    await a.prompt.accept()
    expect(a.set).toHaveBeenLastCalledWith({ lowPerfMode: true, lowPerfAsked: true })
    expect(a.seen.at(-1)).toBe(false)
    const b = setup()
    await b.prompt.start()
    await b.prompt.dismiss()
    expect(b.state.lowPerfMode).toBe(false)
    expect(b.seen.at(-1)).toBe(false)
  })
  test('Settings read failure → silently skip the prompt', async () => {
    const seen: boolean[] = []
    const p = createLowPerfPrompt(
      { getSettings: async () => Promise.reject(new Error('x')), setSettings: vi.fn(), mediaCapabilities: mc({ supported: false, smooth: false, powerEfficient: false }) },
      (v) => seen.push(v)
    )
    await p.start()
    await tick()
    expect(seen).toEqual([])
  })
})

describe('Wiring and copy', () => {
  test('Copy matches the requirements exactly and comes from zh-TW.ts', () => {
    expect(i18n.lowPerf.askText).toBe('偵測到此電腦沒有硬體解碼，要開啟低效能模式嗎？')
    expect(i18n.lowPerf.enable).toBe('開啟')
    expect(i18n.lowPerf.dismiss).toBe('不用了')
  })
  test('App mounts the settings watcher and prompt component', () => {
    const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf-8')
    expect(app).toMatch(/watchLowPerfSetting\(window\.api\)/)
    expect(app).toMatch(/<LowPerfNotice\b/)
  })
})
