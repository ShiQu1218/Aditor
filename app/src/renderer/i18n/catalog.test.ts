import { describe, expect, it } from 'vitest'
import { catalogFor, LOCALES, type Locale } from './index'

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
const HAN = /[㐀-鿿]/
const HAN_TRADITIONAL_ONLY = /[這個們為與機對檔區資訊錄選項設備顯頁開關說讓應該從點擊還後經過連線編輯庫]/

type Leaf = { path: string; value: string | string[] }

function leaves(node: unknown, path = ''): Leaf[] {
  if (typeof node === 'string') return [{ path, value: node }]
  if (Array.isArray(node)) return [{ path, value: node as string[] }]
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([key, child]) => leaves(child, path ? `${path}.${key}` : key))
  }
  return []
}

const source = leaves(catalogFor('zh-TW'))
const sourceByPath = new Map(source.map((leaf) => [leaf.path, leaf.value]))

describe.each(LOCALES.filter((l): l is Exclude<Locale, 'zh-TW'> => l !== 'zh-TW'))('語言包 %s', (locale) => {
  const target = leaves(catalogFor(locale))
  const targetByPath = new Map(target.map((leaf) => [leaf.path, leaf.value]))

  it('鍵與繁中完全相同', () => {
    expect([...targetByPath.keys()]).toEqual([...sourceByPath.keys()])
  })

  it('每個字串的佔位符與繁中一致、且不是空字串', () => {
    const bad: string[] = []
    for (const [path, original] of sourceByPath) {
      const translated = targetByPath.get(path)
      if (typeof original === 'string') {
        const t = translated as string
        if (typeof t !== 'string' || t.trim() === '') bad.push(`${path}: 空白`)
        else if (placeholders(original).join() !== placeholders(t).join()) bad.push(`${path}: 佔位符 ${placeholders(original)} → ${placeholders(t)}`)
      } else {
        // 搜尋關鍵字：筆數可與繁中不同，但每一筆都要有內容
        for (const t of translated as string[]) if (typeof t !== 'string' || t.trim() === '') bad.push(`${path}: 關鍵字空白`)
      }
    }
    expect(bad).toEqual([])
  })

  it('搜尋關鍵字陣列都有內容', () => {
    for (const leaf of target) if (Array.isArray(leaf.value)) expect(leaf.value.length, leaf.path).toBeGreaterThan(0)
  })

  if (locale === 'en' || locale === 'ko') {
    it('沒有殘留中文字', () => {
      // 語言名稱（日本語、한국어）本來就要能用原文搜尋
      const stray = target.filter((leaf) => !leaf.path.endsWith('language.keywords'))
        .flatMap((leaf) => (Array.isArray(leaf.value) ? leaf.value : [leaf.value]).filter((v) => HAN.test(v)).map((v) => `${leaf.path}: ${v}`))
      expect(stray).toEqual([])
    })
  }

  if (locale === 'zh-CN') {
    it('沒有殘留繁體專用字', () => {
      const stray = target.flatMap((leaf) => (Array.isArray(leaf.value) ? leaf.value : [leaf.value]).filter((v) => HAN_TRADITIONAL_ONLY.test(v)).map((v) => `${leaf.path}: ${v}`))
      expect(stray).toEqual([])
    })
  }
})
