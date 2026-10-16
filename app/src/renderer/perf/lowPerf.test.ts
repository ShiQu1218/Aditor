import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { genLong } from '../../../test/fixtures/genEvents'
import { layoutTimeline } from '../timeline/layout'
import { drawTimeline, type DrawModel, type Theme } from '../timeline/draw'
import type { View } from '../timeline/model'
import type { EventType } from '../../shared/types'
import {
  HEAT_BINS_LOWPERF,
  bindLowPerfRoot,
  heatBinCount,
  isLowPerf,
  setLowPerf,
  subscribeLowPerf,
  watchLowPerfSetting
} from './lowPerf'

function fakeRoot() {
  const attrs = new Map<string, string>()
  return {
    attrs,
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    removeAttribute: (k: string) => void attrs.delete(k),
    hasAttribute: (k: string) => attrs.has(k)
  }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('data-lowperf 屬性反映設定', () => {
  test('setLowPerf 切換 <html data-lowperf> 並通知訂閱者', () => {
    const root = fakeRoot()
    bindLowPerfRoot(root)
    const seen: boolean[] = []
    const off = subscribeLowPerf((v) => seen.push(v))
    setLowPerf(true)
    expect(root.attrs.has('data-lowperf')).toBe(true)
    expect(isLowPerf()).toBe(true)
    setLowPerf(false)
    expect(root.attrs.has('data-lowperf')).toBe(false)
    expect(seen).toEqual([true, false])
    off()
    setLowPerf(true)
    expect(seen).toEqual([true, false])
    setLowPerf(false)
  })

  test('watchLowPerfSetting：啟動時讀 settings.lowPerfMode，之後 settings:changed 即時切換', async () => {
    const root = fakeRoot()
    bindLowPerfRoot(root)
    const listeners = new Set<(s: unknown) => void>()
    const api = {
      settings: {
        get: async () => ({ lowPerfMode: true }),
        onChanged: (cb: (s: unknown) => void) => (listeners.add(cb), () => listeners.delete(cb))
      }
    }
    const off = watchLowPerfSetting(api)
    await tick()
    expect(root.attrs.has('data-lowperf')).toBe(true)
    listeners.forEach((l) => l({ lowPerfMode: false }))
    expect(root.attrs.has('data-lowperf')).toBe(false)
    listeners.forEach((l) => l({ lowPerfMode: true }))
    expect(root.attrs.has('data-lowperf')).toBe(true)
    off()
    expect(listeners.size).toBe(0)
    setLowPerf(false)
  })

  test('沒有 api 時不丟錯、維持關閉', () => {
    bindLowPerfRoot(fakeRoot())
    expect(() => watchLowPerfSetting(undefined)()).not.toThrow()
    expect(isLowPerf()).toBe(false)
  })
})

describe('lowperf.css 規則（掃描）', () => {
  const css = readFileSync(resolve(__dirname, '../styles/lowperf.css'), 'utf-8')
  test('data-lowperf 關閉所有 transition／animation', () => {
    expect(css).toMatch(/html\[data-lowperf\][^{]*\*[^{]*\{[^}]*transition:\s*none\s*!important/)
    expect(css).toMatch(/html\[data-lowperf\][^{]*\*[^{]*\{[^}]*animation:\s*none\s*!important/)
  })
  test('尊重 prefers-reduced-motion', () => {
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/)
    const block = css.slice(css.indexOf('prefers-reduced-motion'))
    expect(block).toMatch(/transition:\s*none\s*!important/)
    expect(block).toMatch(/animation:\s*none\s*!important/)
  })
  test('移除 hover 位移（卡片 translate）', () => {
    expect(css).toMatch(/html\[data-lowperf\]\s+\.vcard:hover\s*\{[^}]*transform:\s*none/)
  })
  test('main.tsx 載入 fonts.css 與 lowperf.css（lowperf 在最後以覆蓋其他樣式）', () => {
    const main = readFileSync(resolve(__dirname, '../main.tsx'), 'utf-8')
    expect(main).toMatch(/styles\/fonts\.css/)
    const iLow = main.indexOf('styles/lowperf.css')
    expect(iLow).toBeGreaterThan(-1)
    for (const f of ['shell', 'library', 'settings'])
      expect(main.indexOf(`styles/${f}.css`)).toBeLessThan(iLow)
  })
})

describe('熱度條 bins', () => {
  test('heatBinCount：一般依像素寬度，低效能固定 60', () => {
    expect(HEAT_BINS_LOWPERF).toBe(60)
    expect(heatBinCount(1400, true, false)).toBe(350)
    expect(heatBinCount(1400, false, false)).toBe(Math.ceil(1400 / 6))
    expect(heatBinCount(1400, true, true)).toBe(60)
    expect(heatBinCount(1400, false, true)).toBe(60)
    expect(heatBinCount(0, true, true)).toBe(0)
  })

  class FakePath2D {}
  beforeAll(() => vi.stubGlobal('Path2D', FakePath2D))
  afterAll(() => vi.unstubAllGlobals())

  function heatRects(lowPerf: boolean): number {
    const { events, duration } = genLong(600)
    const v: View = { duration, start: 0, span: duration, width: 1400 }
    const ALL = new Set<EventType>(['knock', 'assist_knock', 'assist_elim', 'elim', 'squad_wipe'])
    const m: DrawModel = {
      width: 1400,
      height: 132,
      view: v,
      duration,
      layout: layoutTimeline(events, v, ALL),
      spectating: [],
      clips: [],
      selected: new Set(),
      lowPerf
    }
    const th = { heatRgb: '1, 2, 3', events: {} } as unknown as Theme
    let fill = ''
    let n = 0
    const g = new Proxy(
      {},
      {
        get: (_t, p: string) => (...a: unknown[]): unknown => {
          void a
          if (p === 'fillRect' && fill.startsWith('rgba(1, 2, 3,')) n++
          return p === 'measureText' ? { width: 1 } : undefined
        },
        set: (_t, p: string, v) => {
          if (p === 'fillStyle') fill = String(v)
          return true
        }
      }
    ) as unknown as CanvasRenderingContext2D
    drawTimeline(g, m, th)
    return n
  }
  test('drawTimeline：lowPerf 只畫 ≤60 根熱度條，一般模式遠多於 60', () => {
    expect(heatRects(true)).toBeLessThanOrEqual(HEAT_BINS_LOWPERF)
    expect(heatRects(true)).toBeGreaterThan(30)
    expect(heatRects(false)).toBeGreaterThan(HEAT_BINS_LOWPERF)
  })
})
