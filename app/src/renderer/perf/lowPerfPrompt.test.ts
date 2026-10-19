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

describe('lacksHardwareDecode（純決策）', () => {
  test('探測 1080p60 H.264', () => {
    expect(PROBE_CONFIG.video).toMatchObject({ width: 1920, height: 1080, framerate: 60 })
    expect(PROBE_CONFIG.video.contentType).toMatch(/avc1/)
  })
  test('不支援／不流暢／非省電(無硬體解碼) → true；流暢且省電 → false', async () => {
    expect(await lacksHardwareDecode(mc({ supported: true, smooth: true, powerEfficient: true }))).toBe(false)
    expect(await lacksHardwareDecode(mc({ supported: true, smooth: true, powerEfficient: false }))).toBe(true)
    expect(await lacksHardwareDecode(mc({ supported: true, smooth: false, powerEfficient: true }))).toBe(true)
    expect(await lacksHardwareDecode(mc({ supported: false, smooth: false, powerEfficient: false }))).toBe(true)
  })
  test('API 不存在或丟錯 → false（不打擾使用者）', async () => {
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

describe('首次啟動低效能詢問', () => {
  test('無硬體解碼且從未詢問 → 顯示，並立即記 lowPerfAsked（只問一次）', async () => {
    const { prompt, set, seen } = setup()
    await prompt.start()
    expect(seen.at(-1)).toBe(true)
    expect(set).toHaveBeenCalledWith({ lowPerfAsked: true })
    // 下次啟動（lowPerfAsked 已為 true）不再顯示
    const next = setup({ lowPerfAsked: true })
    await next.prompt.start()
    expect(next.seen).toEqual([])
  })
  test('有硬體解碼 → 不顯示、也不寫設定', async () => {
    const { prompt, set, seen } = setup({}, { supported: true, smooth: true, powerEfficient: true })
    await prompt.start()
    expect(seen).toEqual([])
    expect(set).not.toHaveBeenCalled()
  })
  test('已開啟低效能模式 → 不顯示', async () => {
    const { prompt, seen } = setup({ lowPerfMode: true })
    await prompt.start()
    expect(seen).toEqual([])
  })
  test('〔開啟〕→ lowPerfMode:true 並關閉通知；〔不用了〕→ 只關閉通知', async () => {
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
  test('設定讀取失敗 → 靜默不顯示', async () => {
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

describe('接線與文案', () => {
  test('文案與需求完全一致，來自 zh-TW.ts', () => {
    expect(i18n.lowPerf.askText).toBe('偵測到此電腦沒有硬體解碼，要開啟低效能模式嗎？')
    expect(i18n.lowPerf.enable).toBe('開啟')
    expect(i18n.lowPerf.dismiss).toBe('不用了')
  })
  test('App 掛上設定監看與詢問元件', () => {
    const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf-8')
    expect(app).toMatch(/watchLowPerfSetting\(window\.api\)/)
    expect(app).toMatch(/<LowPerfNotice\b/)
  })
})
