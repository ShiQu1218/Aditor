import { DEFAULT_LOCALE, LOCALES, setActiveLocale, type Locale } from '../../shared/locale'
import { zhTW } from './zh-TW'
import { zhCN } from './zh-CN'
import { en } from './en'
import { ja } from './ja'
import { ko } from './ko'

export { LOCALES, LOCALE_NAMES, DEFAULT_LOCALE, matchLocale, resolveLocale, isLocale, type Locale, type LanguageSetting } from '../../shared/locale'

type Widen<T> = T extends string ? string
  : T extends readonly (infer U)[] ? readonly Widen<U>[]
  : T extends object ? { [K in keyof T]: Widen<T[K]> }
  : T

/** 一套語言的全部介面文字；鍵與結構以繁體中文（zh-TW.ts）為準，其他語言由型別檢查補齊。 */
export type Messages = Widen<typeof zhTW>

const CATALOGS: Readonly<Record<Locale, Messages>> = { 'zh-TW': zhTW, 'zh-CN': zhCN, en, ja, ko }

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
setActiveLocale(currentLocale)
if (typeof document !== 'undefined') document.documentElement.lang = currentLocale
export const { i18n, shellI18n, settingsI18n, recordingI18n, liveI18n } = catalogFor(currentLocale)
