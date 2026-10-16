// 鎖定 spec §5.1 的對比矩陣（含 §9 評審修正）：讀取實際生效的 CSS（tokens.css ＋ overrides.css），
// 任何 token 被改動而違反矩陣時此測試失敗。
import { describe, expect, test } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { composite, contrast, parseCssVars, parseColor } from './contrast'

const styles = resolve(__dirname, '../styles')
const read = (f: string): string => (existsSync(resolve(styles, f)) ? readFileSync(resolve(styles, f), 'utf-8') : '')
// 後載入的 overrides.css 覆蓋 tokens.css（若存在）
const vars = { ...parseCssVars(read('tokens.css')), ...parseCssVars(read('overrides.css')) }
const v = (name: string): string => {
  const x = vars[name]
  if (!x) throw new Error(`missing token ${name}`)
  return x
}

/** spec §5.1 的四種表面：app／surface／raised／selected（selected 為 spec 矩陣中的 #2C2C30，tokens 沒有對應變數） */
const SURFACES: Array<[string, string]> = [
  ['--bg-app', v('--bg-app')],
  ['--bg-surface', v('--bg-surface')],
  ['--bg-raised', v('--bg-raised')],
  ['selected #2C2C30', '#2c2c30']
]
const EVENTS = ['--ev-knock', '--ev-assist-knock', '--ev-assist-elim', '--ev-elim', '--ev-squad-wipe']

describe('contrast()（WCAG 2.x 相對亮度）', () => {
  test('黑白 21:1、同色 1:1', () => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 5)
    expect(contrast('#777777', '#777777')).toBeCloseTo(1, 5)
  })
  test('spec §5.1 已知值：text-1 on app ≈ 17.0', () => {
    expect(contrast('#f6f6f6', '#131313')).toBeCloseTo(17.0, 0)
  })
  test('parseColor 支援 #rgb／#rrggbb／rgba()', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 })
    expect(parseColor('rgba(255, 0, 0, 0.5)')).toEqual({ r: 255, g: 0, b: 0, a: 0.5 })
  })
  test('composite：50% 白在黑上 = #808080', () => {
    expect(composite('#ffffff', 0.5, '#000000')).toBe('#808080')
  })
})

describe('spec §5.1 對比矩陣', () => {
  test.each(SURFACES)('--text-3 在 %s 上 ≥ 4.5', (_n, bg) => {
    expect(contrast(v('--text-3'), bg)).toBeGreaterThanOrEqual(4.5)
  })
  test.each(SURFACES)('--text-1／--text-2 在 %s 上 ≥ 4.5', (_n, bg) => {
    expect(contrast(v('--text-1'), bg)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(v('--text-2'), bg)).toBeGreaterThanOrEqual(4.5)
  })
  test('白字 on --accent ≥ 4.5（spec 4.8）', () => {
    expect(contrast(v('--on-accent'), v('--accent'))).toBeGreaterThanOrEqual(4.5)
  })
  test('白字 on --accent-hover ≥ 4.5（spec §9：hover 改為較暗的 #C22820，5.8）', () => {
    expect(v('--accent-hover').toLowerCase()).toBe('#c22820')
    expect(contrast(v('--on-accent'), v('--accent-hover'))).toBeGreaterThanOrEqual(4.5)
  })
  test('hover 比 --accent 更暗（不得回到舊的 #EE3A30）', () => {
    const lum = (c: string): number => {
      const p = parseColor(c)
      return p.r + p.g + p.b
    }
    expect(lum(v('--accent-hover'))).toBeLessThan(lum(v('--accent')))
  })
  test('--accent-bright 在 --bg-app 上 ≥ 4.5（spec 5.8）', () => {
    expect(contrast(v('--accent-bright'), v('--bg-app'))).toBeGreaterThanOrEqual(4.5)
  })
  test.each(EVENTS)('%s 在時間軸底 --tl-bg 上 ≥ 4.4', (name) => {
    expect(contrast(v(name), v('--tl-bg'))).toBeGreaterThanOrEqual(4.4)
  })
  test.each(EVENTS)('%s 不計入（65% 不透明合成於 --tl-bg）≥ 3.0', (name) => {
    const alpha = Number(v('--ev-uncounted-alpha'))
    expect(alpha).toBe(0.65)
    const fg = composite(v(name), alpha, v('--tl-bg'))
    expect(contrast(fg, v('--tl-bg'))).toBeGreaterThanOrEqual(3.0)
  })
  test('不計入各色與 spec 表值一致（±0.05）', () => {
    const want: Record<string, number> = {
      '--ev-knock': 3.98,
      '--ev-assist-knock': 4.3,
      '--ev-assist-elim': 4.82,
      '--ev-elim': 6.63,
      '--ev-squad-wipe': 3.16
    }
    for (const [name, c] of Object.entries(want)) {
      const fg = composite(v(name), 0.65, v('--tl-bg'))
      expect(contrast(fg, v('--tl-bg'))).toBeCloseTo(c, 1)
    }
  })
})
