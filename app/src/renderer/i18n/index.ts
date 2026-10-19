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

/** All interface text for one language; Traditional Chinese (zh-TW.ts) defines keys and structure, with type checking enforcing other catalogs. */
export type Messages = Widen<typeof zhTW>

const CATALOGS: Readonly<Record<Locale, Messages>> = { 'zh-TW': zhTW, 'zh-CN': zhCN, en, ja, ko }

export function catalogFor(locale: Locale): Messages {
  return CATALOGS[locale]
}

/**
 * Renderer startup locale: main supplies `?lang=` when loading the page (see main/index.ts); changing language reloads the window.
 * Module-level text references therefore need no live switching. Use the default locale without a parameter (tests and browser-only development).
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
