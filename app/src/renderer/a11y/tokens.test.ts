import { describe, expect, test } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { parseCssVars } from './contrast'

const renderer = resolve(__dirname, '..')
const mockTokens = resolve(__dirname, '../../../../docs/design/ui-mock/css/tokens.css')
const appTokens = resolve(renderer, 'styles/tokens.css')

function walk(dir: string, ext: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(resolve(dir, e.name), ext) : ext.test(e.name) ? [resolve(dir, e.name)] : []
  )
}

describe('tokens.css 與設計稿 mock 不漂移', () => {
  const app = parseCssVars(readFileSync(appTokens, 'utf-8'))
  const mock = parseCssVars(readFileSync(mockTokens, 'utf-8'))

  test('變數集合相同', () => {
    expect(Object.keys(app).sort()).toEqual(Object.keys(mock).sort())
    expect(Object.keys(app).length).toBeGreaterThan(60)
  })
  test('每個變數的值相同', () => {
    expect(app).toEqual(mock)
  })
  test('位元組完全相同（app 的 tokens.css 是 mock 的原樣複本）', () => {
    expect(readFileSync(appTokens).equals(readFileSync(mockTokens))).toBe(true)
  })
})

describe('效能規則：不使用 backdrop-filter', () => {
  const cssFiles = walk(renderer, /\.css$/)
  test('有掃到樣式表', () => {
    expect(cssFiles.length).toBeGreaterThanOrEqual(10)
  })
  test('任何 CSS 都沒有 backdrop-filter', () => {
    const offenders = cssFiles.filter((f) => /backdrop-filter/i.test(readFileSync(f, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '')))
    expect(offenders).toEqual([])
  })
  test('TSX／TS 內聯樣式也沒有 backdrop-filter／backdropFilter', () => {
    const offenders = walk(renderer, /\.(ts|tsx)$/).filter(
      (f) => !/\.test\.ts$/.test(f) && /backdrop-?filter/i.test(readFileSync(f, 'utf-8'))
    )
    expect(offenders).toEqual([])
  })
})
