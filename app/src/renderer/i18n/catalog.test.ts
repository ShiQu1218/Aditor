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

describe.each(LOCALES.filter((l): l is Exclude<Locale, 'zh-TW'> => l !== 'zh-TW'))('Locale catalog %s', (locale) => {
  const target = leaves(catalogFor(locale))
  const targetByPath = new Map(target.map((leaf) => [leaf.path, leaf.value]))

it('Keys exactly match zh-TW', () => {
    expect([...targetByPath.keys()]).toEqual([...sourceByPath.keys()])
  })

it('Every string has the same placeholders as zh-TW and is non-empty', () => {
    const bad: string[] = []
    for (const [path, original] of sourceByPath) {
      const translated = targetByPath.get(path)
      if (typeof original === 'string') {
        const t = translated as string
        if (typeof t !== 'string' || t.trim() === '') bad.push(`${path}: empty value`)
        else if (placeholders(original).join() !== placeholders(t).join()) bad.push(`${path}: placeholders ${placeholders(original)} → ${placeholders(t)}`)
      } else {
        // Search keywords may differ in count from Traditional Chinese, but every entry must have a value.
        for (const t of translated as string[]) if (typeof t !== 'string' || t.trim() === '') bad.push(`${path}: empty search keyword`)
      }
    }
    expect(bad).toEqual([])
  })

it('Search keyword arrays are non-empty', () => {
    for (const leaf of target) if (Array.isArray(leaf.value)) expect(leaf.value.length, leaf.path).toBeGreaterThan(0)
  })

  if (locale === 'en' || locale === 'ko') {
it('Contains no untranslated Chinese characters', () => {
      // Language names (日本語 and 한국어) must be searchable in their original form.
      const stray = target.filter((leaf) => !leaf.path.endsWith('language.keywords'))
        .flatMap((leaf) => (Array.isArray(leaf.value) ? leaf.value : [leaf.value]).filter((v) => HAN.test(v)).map((v) => `${leaf.path}: ${v}`))
      expect(stray).toEqual([])
    })
  }

  if (locale === 'zh-CN') {
it('Contains no Traditional Chinese-only characters', () => {
      const stray = target.flatMap((leaf) => (Array.isArray(leaf.value) ? leaf.value : [leaf.value]).filter((v) => HAN_TRADITIONAL_ONLY.test(v)).map((v) => `${leaf.path}: ${v}`))
      expect(stray).toEqual([])
    })
  }
})
