import { describe, expect, it } from 'vitest'
import { matchLocale, resolveLocale } from './locale'

describe('matchLocale: maps system language tags to supported languages', () => {
  it.each([
    ['zh-TW', 'zh-TW'], ['zh-Hant-TW', 'zh-TW'], ['zh-HK', 'zh-TW'], ['zh-MO', 'zh-TW'],
    ['zh-CN', 'zh-CN'], ['zh-Hans', 'zh-CN'], ['zh-SG', 'zh-CN'], ['zh', 'zh-CN'],
    ['en-US', 'en'], ['en-GB', 'en'], ['en', 'en'],
    ['ja-JP', 'ja'], ['ja', 'ja'], ['ko-KR', 'ko'], ['ko_KR', 'ko']
  ])('%s → %s', (tag, expected) => {
    expect(matchLocale(tag)).toBe(expected)
  })

  it.each(['de-DE', 'fr', 'es-ES', 'ru', '', null, undefined])('unsupported language %s → null', (tag) => {
    expect(matchLocale(tag as string | null | undefined)).toBeNull()
  })
})

describe('resolveLocale: setting and system language', () => {
  it('always uses the specified language, regardless of the system language', () => {
    expect(resolveLocale('ja', 'en-US')).toBe('ja')
    expect(resolveLocale('zh-TW', 'ko-KR')).toBe('zh-TW')
  })

  it('auto follows the system language', () => {
    expect(resolveLocale('auto', 'ko-KR')).toBe('ko')
    expect(resolveLocale('auto', 'zh-Hant-TW')).toBe('zh-TW')
    expect(resolveLocale('auto', 'zh-CN')).toBe('zh-CN')
  })

  it('defaults to English when the system language is unsupported or unavailable', () => {
    expect(resolveLocale('auto', 'de-DE')).toBe('en')
    expect(resolveLocale('auto', 'fr')).toBe('en')
    expect(resolveLocale('auto', '')).toBe('en')
    expect(resolveLocale('auto', undefined)).toBe('en')
  })

  it('follows the system language and then falls back to English when the setting is invalid (old file or manual edit)', () => {
    expect(resolveLocale('klingon', 'ja-JP')).toBe('ja')
    expect(resolveLocale(undefined, 'de-DE')).toBe('en')
  })
})
