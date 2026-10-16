import path from 'path'
import { DEFAULT_SETTINGS, Settings } from '../shared/settings'

const LANG_DIR_NAMES = ['zh-TW', 'en', 'ja', 'auto']

/** 設定中影響引擎 analyze 的欄位（decode／cacheLocation／gameLang）的最小形狀。 */
export type AnalyzeSettings = Pick<Settings, 'decode' | 'cacheLocation'> & Partial<Pick<Settings, 'gameLang'>>

/** decode=software → hwaccel:false；cacheLocation=besideVideo → beside:true（引擎 ipc `analyze` 參數）。 */
export function analyzeSettingArgs(s: AnalyzeSettings | undefined): { hwaccel: boolean; beside: boolean } {
  const cur = s ?? DEFAULT_SETTINGS
  return { hwaccel: cur.decode !== 'software', beside: cur.cacheLocation === 'besideVideo' }
}

/**
 * 依設定的 gameLang 將基準 profileDir 轉換為對應語言範本目錄（auto 為 templates 根目錄）。
 * 基準目錄名稱若是某個語言資料夾（zh-TW／en／ja／auto），先回到其上層的 templates 根目錄；否則視為 templates 根目錄。
 */
export function resolveAnalyzeProfileDir(baseProfileDir: string, s: AnalyzeSettings | undefined): string {
  const lang = s?.gameLang
  if (!lang) {
    return baseProfileDir
  }
  const templatesRoot = LANG_DIR_NAMES.includes(path.basename(baseProfileDir))
    ? path.dirname(baseProfileDir)
    : baseProfileDir
  return lang === 'auto' ? templatesRoot : path.join(templatesRoot, lang)
}

/**
 * 組 analyze 請求：以 base 為底、疊上 renderer 傳來的欄位，但 hwaccel／beside 一律以設定為準；
 * 設定了 gameLang 時 profile_dir 也由主程序依設定決定（renderer 傳來的 profile_dir 不採用）。
 */
export function buildAnalyzeArgs(
  base: Record<string, unknown>,
  settings: AnalyzeSettings | undefined,
  rendererArgs: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base, ...rendererArgs, ...analyzeSettingArgs(settings) }
  if (typeof base.profile_dir === 'string' && settings?.gameLang) {
    merged.profile_dir = resolveAnalyzeProfileDir(base.profile_dir, settings)
  }
  return merged
}
