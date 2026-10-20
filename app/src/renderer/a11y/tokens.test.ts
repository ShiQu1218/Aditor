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

describe('tokens.css matches the design mock', () => {
  const app = parseCssVars(readFileSync(appTokens, 'utf-8'))
  const mock = parseCssVars(readFileSync(mockTokens, 'utf-8'))

  test('Variable sets match', () => {
    expect(Object.keys(app).sort()).toEqual(Object.keys(mock).sort())
    expect(Object.keys(app).length).toBeGreaterThan(60)
  })
  test('Every variable has the same value', () => {
    expect(app).toEqual(mock)
  })
  test('Styles match the mock independently of documentation comments and line endings', () => {
    const styles = (file: string): string => readFileSync(file, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim()
    expect(styles(appTokens)).toBe(styles(mockTokens))
  })
})

describe('Performance rule: do not use backdrop-filter', () => {
  const cssFiles = walk(renderer, /\.css$/)
  test('Scans at least one stylesheet', () => {
    expect(cssFiles.length).toBeGreaterThanOrEqual(10)
  })
  test('No CSS file uses backdrop-filter', () => {
    const offenders = cssFiles.filter((f) => /backdrop-filter/i.test(readFileSync(f, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '')))
    expect(offenders).toEqual([])
  })
  test('TSX/TS inline styles do not use backdrop-filter or backdropFilter', () => {
    const offenders = walk(renderer, /\.(ts|tsx)$/).filter(
      (f) => !/\.test\.ts$/.test(f) && /backdrop-?filter/i.test(readFileSync(f, 'utf-8'))
    )
    expect(offenders).toEqual([])
  })
})
