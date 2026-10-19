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

/** 掃描原始碼裡所有 `tr('原文'…)` 的原文（必須是單純字串字面值）。 */
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
  it('繁中回傳原文並代入佔位符；缺少的變數保留原樣', () => {
    setActiveLocale('zh-TW')
    expect(tr('第 {index} 局開始', { index: 3 })).toBe('第 3 局開始')
    expect(tr('第 {index} 局開始', {})).toBe('第 {index} 局開始')
  })

  it('其他語言查不到時退回原文，查到時使用譯文', () => {
    setActiveLocale('en')
    expect(tr('這句話沒有翻譯')).toBe('這句話沒有翻譯')
    setActiveLocale('zh-TW')
  })

  it('原始碼有使用 tr()（掃描規則沒有失效）', () => {
    expect(used.size).toBeGreaterThan(10)
  })
})

describe.each([['en', en], ['ja', ja], ['ko', ko], ['zh-CN', zhCN]] as Array<[string, MessageTable]>)('訊息表 %s', (_name, table) => {
  it('涵蓋原始碼中所有 tr() 原文', () => {
    const missing = [...used.entries()].filter(([key]) => !(key in table)).map(([key, file]) => `${file}: ${key}`)
    expect(missing).toEqual([])
  })

  it('沒有已不再使用的多餘條目', () => {
    expect(Object.keys(table).filter((key) => !used.has(key))).toEqual([])
  })

  it('佔位符與原文一致、譯文不為空', () => {
    const bad = Object.entries(table).filter(([key, value]) => value.trim() === '' || placeholders(key) !== placeholders(value)).map(([key]) => key)
    expect(bad).toEqual([])
  })
})
