import { describe, expect, test } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { resolve } from 'path'

const root = resolve(__dirname, '../../..')
const fontsDir = resolve(__dirname, '../assets/fonts')
const css = readFileSync(resolve(__dirname, 'fonts.css'), 'utf-8')
const tokens = readFileSync(resolve(__dirname, 'tokens.css'), 'utf-8')

describe('bundled fonts', () => {
  const woff2 = readdirSync(fontsDir).filter((f) => f.endsWith('.woff2'))

  test('exactly the 4 needed Latin woff2 files (Lato 400/700, Montserrat 700/900)', () => {
    expect(woff2.sort()).toEqual([
      'lato-latin-400-normal.woff2',
      'lato-latin-700-normal.woff2',
      'montserrat-latin-700-normal.woff2',
      'montserrat-latin-900-normal.woff2'
    ])
  })

  test('total size < 200 KB', () => {
    const total = woff2.reduce((n, f) => n + statSync(resolve(fontsDir, f)).size, 0)
    expect(total).toBeLessThan(200 * 1024)
  })

  test('README documents origin and version', () => {
    const readme = readFileSync(resolve(fontsDir, 'README.md'), 'utf-8')
    expect(readme).toMatch(/@fontsource\/lato/)
    expect(readme).toMatch(/@fontsource\/montserrat/)
    expect(readme).toMatch(/OFL/)
    expect(readme).toMatch(/\d+\.\d+\.\d+/)
  })

  test('fonts.css: one @font-face per file, swap, no synthesis, unicode-range, relative url, no network', () => {
    const faces = css.match(/@font-face\s*\{[^}]*\}/g) ?? []
    expect(faces).toHaveLength(4)
    for (const f of woff2) {
      expect(css).toContain(`../assets/fonts/${f}`)
      expect(existsSync(resolve(__dirname, '../assets/fonts', f))).toBe(true)
    }
    for (const face of faces) {
      expect(face).toMatch(/font-display:\s*swap/)
      expect(face).toMatch(/unicode-range:\s*U\+0000-00FF/)
      expect(face).toMatch(/format\('woff2'\)/)
    }
    expect(css).toMatch(/font-synthesis:\s*none/)
    expect(css).not.toMatch(/https?:|\/\/fonts\.|@import/)
  })

  test('token font stacks lead with the bundled families (Chinese stays on system fallback)', () => {
    expect(tokens).toMatch(/--font-display:\s*'Montserrat'/)
    expect(tokens).toMatch(/--font-ui:\s*'Lato'/)
    expect(css).not.toMatch(/Noto|JhengHei/)
  })

  test('no Google Fonts / remote font references anywhere in the renderer sources or html', () => {
    const html = readFileSync(resolve(__dirname, '../index.html'), 'utf-8')
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)|https?:\/\//)
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(resolve(d, e.name)) : /\.(css|html)$/.test(e.name) ? [resolve(d, e.name)] : []
      )
    for (const f of walk(resolve(__dirname, '..'))) {
      expect(readFileSync(f, 'utf-8'), f).not.toMatch(/fonts\.(googleapis|gstatic)\.com/)
    }
  })

  test('THIRD_PARTY_NOTICES lists Lato and Montserrat with OFL 1.1', () => {
    const n = readFileSync(resolve(root, '../THIRD_PARTY_NOTICES.md'), 'utf-8')
    expect(n).toMatch(/Lato/)
    expect(n).toMatch(/Montserrat/)
    expect(n).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/)
    expect(n).toMatch(/Copyright.*Lukasz Dziedzic/)
    expect(n).toMatch(/Copyright 2011 The Montserrat Project Authors/)
  })
})
