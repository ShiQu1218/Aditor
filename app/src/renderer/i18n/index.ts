import { zhTW } from './zh-TW'
import { zhCN } from './zh-CN'
import { en } from './en'
import { ja } from './ja'
import { ko } from './ko'

type Widen<T> = T extends string ? string
  : T extends readonly (infer U)[] ? readonly Widen<U>[]
  : T extends object ? { [K in keyof T]: Widen<T[K]> }
  : T

/** 一套語言的全部介面文字；鍵與結構以繁體中文（zh-TW.ts）為準，其他語言由型別檢查補齊。 */
export type Messages = Widen<typeof zhTW>

export const LOCALES = ['zh-TW', 'zh-CN', 'en', 'ja', 'ko'] as const
export type Locale = (typeof LOCALES)[number]
/** 設定值：'auto' 依系統語言決定。 */
export type LanguageSetting = 'auto' | Locale

/** 各語言的自稱（語言選單固定用原文顯示，不隨目前介面語言翻譯）。 */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = {
  'zh-TW': '繁體中文', 'zh-CN': '简体中文', en: 'English', ja: '日本語', ko: '한국어'
}

const CATALOGS: Readonly<Record<Locale, Messages>> = { 'zh-TW': zhTW, 'zh-CN': zhCN, en, ja, ko }
export const DEFAULT_LOCALE: Locale = 'zh-TW'

/** 把 BCP 47 語言標籤（`zh-Hant-TW`、`en-US`、`ja`…）對應到支援的語言；不支援時回傳 null。 */
export function matchLocale(tag: string | null | undefined): Locale | null {
  if (!tag) return null
  const t = tag.toLowerCase().replace(/_/g, '-')
  if (t === 'zh' || t.startsWith('zh-')) {
    return /(^|-)(hant|tw|hk|mo)(-|$)/.test(t) ? 'zh-TW' : 'zh-CN'
  }
  const base = t.split('-')[0]
  return base === 'en' || base === 'ja' || base === 'ko' ? base : null
}

/** 設定值（含 'auto'）轉成實際語言；auto 依 `systemTag`（例如 `app.getLocale()`），都不支援就用預設。 */
export function resolveLocale(setting: string | null | undefined, systemTag?: string | null): Locale {
  if (setting && (LOCALES as readonly string[]).includes(setting)) return setting as Locale
  return matchLocale(systemTag) ?? DEFAULT_LOCALE
}

export function catalogFor(locale: Locale): Messages {
  return CATALOGS[locale]
}

/**
 * renderer 啟動時的語言：main 載入頁面時以 `?lang=` 帶入（見 main/index.ts），換語言會重新載入視窗；
 * 因此各模組頂層引用文字不必處理即時切換。沒有參數（測試、純瀏覽器開發）用預設語言。
 */
function bootLocale(): Locale {
  const search = typeof location === 'undefined' ? '' : location.search
  const lang = new URLSearchParams(search).get('lang')
  return lang && (LOCALES as readonly string[]).includes(lang) ? (lang as Locale) : DEFAULT_LOCALE
}

export const currentLocale: Locale = bootLocale()
export const { i18n, shellI18n, settingsI18n, recordingI18n, liveI18n } = catalogFor(currentLocale)
