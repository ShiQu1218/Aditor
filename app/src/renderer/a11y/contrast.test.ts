// Enforce the contrast matrix in spec §5.1, including the review changes in §9, using the effective CSS (tokens.css plus overrides.css).
// This test fails if a token change violates the matrix.
import { describe, expect, test } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { composite, contrast, parseCssVars, parseColor } from './contrast'

const styles = resolve(__dirname, '../styles')
const read = (f: string): string => (existsSync(resolve(styles, f)) ? readFileSync(resolve(styles, f), 'utf-8') : '')
// overrides.css, when present, overrides tokens.css because it loads later.
const vars = { ...parseCssVars(read('tokens.css')), ...parseCssVars(read('overrides.css')) }
const v = (name: string): string => {
  const x = vars[name]
  if (!x) throw new Error(`missing token ${name}`)
  return x
}

/** The four surfaces from spec §5.1: app, surface, raised, and selected (selected is #2C2C30 in the spec matrix and has no token). */
const SURFACES: Array<[string, string]> = [
  ['--bg-app', v('--bg-app')],
  ['--bg-surface', v('--bg-surface')],
  ['--bg-raised', v('--bg-raised')],
  ['selected #2C2C30', '#2c2c30']
]
const EVENTS = ['--ev-knock', '--ev-assist-knock', '--ev-assist-elim', '--ev-elim', '--ev-squad-wipe']

describe('contrast() (WCAG 2.x relative luminance)', () => {
  test('Black and white: 21:1; identical colors: 1:1', () => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 5)
    expect(contrast('#777777', '#777777')).toBeCloseTo(1, 5)
  })
  test('Known value from spec §5.1: text-1 on app ≈ 17.0', () => {
    expect(contrast('#f6f6f6', '#131313')).toBeCloseTo(17.0, 0)
  })
  test('parseColor supports #rgb, #rrggbb, and rgba()', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 })
    expect(parseColor('rgba(255, 0, 0, 0.5)')).toEqual({ r: 255, g: 0, b: 0, a: 0.5 })
  })
  test('composite: 50% white over black = #808080', () => {
    expect(composite('#ffffff', 0.5, '#000000')).toBe('#808080')
  })
})

describe('Spec §5.1 contrast matrix', () => {
  test.each(SURFACES)('--text-3 on %s ≥ 4.5', (_n, bg) => {
    expect(contrast(v('--text-3'), bg)).toBeGreaterThanOrEqual(4.5)
  })
  test.each(SURFACES)('--text-1/--text-2 on %s ≥ 4.5', (_n, bg) => {
    expect(contrast(v('--text-1'), bg)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(v('--text-2'), bg)).toBeGreaterThanOrEqual(4.5)
  })
  test('White text on --accent ≥ 4.5 (spec: 4.8)', () => {
    expect(contrast(v('--on-accent'), v('--accent'))).toBeGreaterThanOrEqual(4.5)
  })
  test('White text on --accent-hover ≥ 4.5 (spec §9: hover darkened to #C22820, 5.8)', () => {
    expect(v('--accent-hover').toLowerCase()).toBe('#c22820')
    expect(contrast(v('--on-accent'), v('--accent-hover'))).toBeGreaterThanOrEqual(4.5)
  })
  test('Hover is darker than --accent (must not revert to the old #EE3A30)', () => {
    const lum = (c: string): number => {
      const p = parseColor(c)
      return p.r + p.g + p.b
    }
    expect(lum(v('--accent-hover'))).toBeLessThan(lum(v('--accent')))
  })
  test('--accent-bright on --bg-app ≥ 4.5 (spec: 5.8)', () => {
    expect(contrast(v('--accent-bright'), v('--bg-app'))).toBeGreaterThanOrEqual(4.5)
  })
  test.each(EVENTS)('%s on the timeline background --tl-bg ≥ 4.4', (name) => {
    expect(contrast(v(name), v('--tl-bg'))).toBeGreaterThanOrEqual(4.4)
  })
  test.each(EVENTS)('%s uncounted (65% opacity composited over --tl-bg) ≥ 3.0', (name) => {
    const alpha = Number(v('--ev-uncounted-alpha'))
    expect(alpha).toBe(0.65)
    const fg = composite(v(name), alpha, v('--tl-bg'))
    expect(contrast(fg, v('--tl-bg'))).toBeGreaterThanOrEqual(3.0)
  })
  test('Uncounted event colors match the spec table values (±0.05)', () => {
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
