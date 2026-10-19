import en from './messages/en'
import ja from './messages/ja'
import ko from './messages/ko'
import zhCN from './messages/zh-CN'

export const LOCALES = ['zh-TW', 'zh-CN', 'en', 'ja', 'ko'] as const
export type Locale = (typeof LOCALES)[number]
/** 設定值：'auto' 依系統語言決定。 */
export type LanguageSetting = 'auto' | Locale
export const LANGUAGE_SETTINGS: readonly LanguageSetting[] = ['auto', ...LOCALES]
export const DEFAULT_LOCALE: Locale = 'zh-TW'

/** 各語言的自稱（語言選單固定用原文顯示，不隨目前介面語言翻譯）。 */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = {
  'zh-TW': '繁體中文', 'zh-CN': '简体中文', en: 'English', ja: '日本語', ko: '한국어'
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}

/** 把 BCP 47 語言標籤（`zh-Hant-TW`、`en-US`、`ja`…）對應到支援的語言；不支援時回傳 null。 */
export function matchLocale(tag: string | null | undefined): Locale | null {
  if (!tag) return null
  const t = tag.toLowerCase().replace(/_/g, '-')
  if (t === 'zh' || t.startsWith('zh-')) return /(^|-)(hant|tw|hk|mo)(-|$)/.test(t) ? 'zh-TW' : 'zh-CN'
  const base = t.split('-')[0]
  return base === 'en' || base === 'ja' || base === 'ko' ? base : null
}

/** 設定值（含 'auto'）轉成實際語言；auto 依 `systemTag`（例如 `app.getLocale()`），都不支援就用預設。 */
export function resolveLocale(setting: unknown, systemTag?: string | null): Locale {
  return isLocale(setting) ? setting : matchLocale(systemTag) ?? DEFAULT_LOCALE
}

/**
 * 程式碼內的零散訊息（main 的通知與錯誤、共用的純函式）以繁體中文原文當鍵：
 * `tr('錄影程序已停止')`。繁中直接回傳原文，其他語言查 `messages/<語言>.ts`，查不到也回傳原文，
 * 所以漏翻只會顯示中文而不會壞掉。`{名稱}` 是佔位符，由 `vars` 代入。
 */
export type MessageTable = Readonly<Record<string, string>>
const TABLES: Readonly<Partial<Record<Locale, MessageTable>>> = { 'zh-CN': zhCN, en, ja, ko }

let active: Locale = DEFAULT_LOCALE
export function setActiveLocale(locale: Locale): void { active = locale }
export function getActiveLocale(): Locale { return active }

export function tr(text: string, vars?: Readonly<Record<string, string | number | null | undefined>>): string {
  const template = TABLES[active]?.[text] ?? text
  return vars ? template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole)) : template
}
