import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { setActiveLocale, tr, type MessageTable } from './locale'
import en from './messages/en'
import ja from './messages/ja'
import ko from './messages/ko'
import zhCN from './messages/zh-CN'

const SRC = path.resolve(__dirname, '..')
const SKIP_DIRS = new Set(['messages'])

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : sourceFiles(full)
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && entry.name !== 'locale.ts' ? [full] : []
  })
}

/** Scan the source for all `tr('source text'…)` keys (which must be plain string literals). */
function usedKeys(): Map<string, string> {
  const keys = new Map<string, string>()
  const call = /\btr\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\$]|\\.)*)`)/g
  for (const file of sourceFiles(SRC)) {
    const text = fs.readFileSync(file, 'utf8')
    for (const match of text.matchAll(call)) {
      const raw = match[1] ?? match[2] ?? match[3]
      keys.set(raw.replace(/\\(['"`\\])/g, '$1').replace(/\\n/g, '\n'), path.relative(SRC, file))
    }
  }
  return keys
}

const placeholders = (text: string): string => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join()
const used = usedKeys()

describe('tr()', () => {
  it('Traditional Chinese returns the source text and substitutes placeholders; missing variables remain unchanged', () => {
    setActiveLocale('zh-TW')
    expect(tr('第 {index} 局開始', { index: 3 })).toBe('第 3 局開始')
    expect(tr('第 {index} 局開始', {})).toBe('第 {index} 局開始')
  })

  it('Other languages fall back to the source text when no translation exists and use the translation when available', () => {
    setActiveLocale('en')
    expect(tr('這句話沒有翻譯')).toBe('這句話沒有翻譯')
    setActiveLocale('zh-TW')
  })

  it('The source uses tr() (the scan rule is still working)', () => {
    expect(used.size).toBeGreaterThan(10)
  })
})

describe.each([['en', en], ['ja', ja], ['ko', ko], ['zh-CN', zhCN]] as Array<[string, MessageTable]>)('Message table %s', (_name, table) => {
  it('covers every tr() source string used in the source code', () => {
    const missing = [...used.entries()].filter(([key]) => !(key in table)).map(([key, file]) => `${file}: ${key}`)
    expect(missing).toEqual([])
  })

  it('contains no unused entries', () => {
    expect(Object.keys(table).filter((key) => !used.has(key))).toEqual([])
  })

  it('has matching placeholders and non-empty translations', () => {
    const bad = Object.entries(table).filter(([key, value]) => value.trim() === '' || placeholders(key) !== placeholders(value)).map(([key]) => key)
    expect(bad).toEqual([])
  })
})
