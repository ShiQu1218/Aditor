import { describe, expect, it } from 'vitest'
import { matchLocale, resolveLocale } from './locale'

describe('matchLocale：系統語言標籤對應到支援的語言', () => {
  it.each([
    ['zh-TW', 'zh-TW'], ['zh-Hant-TW', 'zh-TW'], ['zh-HK', 'zh-TW'], ['zh-MO', 'zh-TW'],
    ['zh-CN', 'zh-CN'], ['zh-Hans', 'zh-CN'], ['zh-SG', 'zh-CN'], ['zh', 'zh-CN'],
    ['en-US', 'en'], ['en-GB', 'en'], ['en', 'en'],
    ['ja-JP', 'ja'], ['ja', 'ja'], ['ko-KR', 'ko'], ['ko_KR', 'ko']
  ])('%s → %s', (tag, expected) => {
    expect(matchLocale(tag)).toBe(expected)
  })

  it.each(['de-DE', 'fr', 'es-ES', 'ru', '', null, undefined])('不支援的語言 %s → null', (tag) => {
    expect(matchLocale(tag as string | null | undefined)).toBeNull()
  })
})

describe('resolveLocale：設定值與系統語言', () => {
  it('指定語言時一律採用，不看系統語言', () => {
    expect(resolveLocale('ja', 'en-US')).toBe('ja')
    expect(resolveLocale('zh-TW', 'ko-KR')).toBe('zh-TW')
  })

  it('auto 跟隨系統語言', () => {
    expect(resolveLocale('auto', 'ko-KR')).toBe('ko')
    expect(resolveLocale('auto', 'zh-Hant-TW')).toBe('zh-TW')
    expect(resolveLocale('auto', 'zh-CN')).toBe('zh-CN')
  })

  it('系統語言不在支援清單、或讀不到時，預設英文', () => {
    expect(resolveLocale('auto', 'de-DE')).toBe('en')
    expect(resolveLocale('auto', 'fr')).toBe('en')
    expect(resolveLocale('auto', '')).toBe('en')
    expect(resolveLocale('auto', undefined)).toBe('en')
  })

  it('設定值無效（舊檔、手改）時同樣跟隨系統，再退回英文', () => {
    expect(resolveLocale('klingon', 'ja-JP')).toBe('ja')
    expect(resolveLocale(undefined, 'de-DE')).toBe('en')
  })
})
