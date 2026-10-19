import en from './messages/en'
import ja from './messages/ja'
import ko from './messages/ko'
import zhCN from './messages/zh-CN'

export const LOCALES = ['zh-TW', 'zh-CN', 'en', 'ja', 'ko'] as const
export type Locale = (typeof LOCALES)[number]
/** Setting value: 'auto' resolves from the system language. */
export type LanguageSetting = 'auto' | Locale
export const LANGUAGE_SETTINGS: readonly LanguageSetting[] = ['auto', ...LOCALES]
/** Language used when none is specified (for example, in tests or when the renderer does not receive `?lang=`). */
export const DEFAULT_LOCALE: Locale = 'zh-TW'
/** Language used when the system language is unsupported or unavailable. */
export const FALLBACK_LOCALE: Locale = 'en'

/** Native names of each language (the language menu always shows these names as-is, regardless of the current interface language). */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = {
  'zh-TW': '繁體中文', 'zh-CN': '简体中文', en: 'English', ja: '日本語', ko: '한국어'
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}

/** Map a BCP 47 language tag (`zh-Hant-TW`, `en-US`, `ja`, etc.) to a supported language; return null when unsupported. */
export function matchLocale(tag: string | null | undefined): Locale | null {
  if (!tag) return null
  const t = tag.toLowerCase().replace(/_/g, '-')
  if (t === 'zh' || t.startsWith('zh-')) return /(^|-)(hant|tw|hk|mo)(-|$)/.test(t) ? 'zh-TW' : 'zh-CN'
  const base = t.split('-')[0]
  return base === 'en' || base === 'ja' || base === 'ko' ? base : null
}

/** Resolve a setting (including 'auto') to an actual language; 'auto' uses `systemTag` (such as `app.getLocale()`), falling back to English if unsupported. */
export function resolveLocale(setting: unknown, systemTag?: string | null): Locale {
  return isLocale(setting) ? setting : matchLocale(systemTag) ?? FALLBACK_LOCALE
}

/**
 * Scattered messages in code (main notifications/errors and shared pure functions) use the Traditional Chinese source text as the key,
 * for example `tr('錄影程序已停止')`. Traditional Chinese returns the source directly; other languages look it up in `messages/<language>.ts`,
 * falling back to the source if no translation exists, so a missing translation only displays Chinese. `{name}` placeholders are filled from `vars`.
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
