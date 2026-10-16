import path from 'path'
import { DEFAULT_SETTINGS, Settings } from '../shared/settings'

/** 設定中影響引擎 analyze 的欄位（decode／cacheLocation／gameLang）的最小形狀。 */
export type AnalyzeSettings = Pick<Settings, 'decode' | 'cacheLocation'> & Partial<Pick<Settings, 'gameLang'>>

/** decode=software → hwaccel:false；cacheLocation=besideVideo → beside:true（引擎 ipc `analyze` 參數）。 */
export function analyzeSettingArgs(s: AnalyzeSettings | undefined): { hwaccel: boolean; beside: boolean } {
  const cur = s ?? DEFAULT_SETTINGS
  return { hwaccel: cur.decode !== 'software', beside: cur.cacheLocation === 'besideVideo' }
}

/** 依設定的 gameLang 將基準 profileDir 轉換為對應語言範本目錄（auto 為 templates 根目錄）。 */
export function resolveAnalyzeProfileDir(baseProfileDir: string, s: AnalyzeSettings | undefined): string {
  const lang = s?.gameLang
  if (!lang) {
    return baseProfileDir
  }
  const baseName = path.basename(baseProfileDir)
  const templatesRoot =
    baseName === 'templates' || !['zh-TW', 'en', 'ja', 'auto'].includes(baseName)
      ? baseProfileDir
      : path.dirname(baseProfileDir)
  return lang === 'auto' ? templatesRoot : path.join(templatesRoot, lang)
}

/** 組 analyze 請求：renderer 傳來的欄位保留，但 hwaccel／beside／profile_dir 一律以設定為準。 */
export function buildAnalyzeArgs(
  base: Record<string, unknown>,
  settings: AnalyzeSettings | undefined,
  rendererArgs: Record<string, unknown>
): Record<string, unknown> {
  const resolvedBase =
    typeof base.profile_dir === 'string' && settings?.gameLang
      ? { ...base, profile_dir: resolveAnalyzeProfileDir(base.profile_dir, settings) }
      : base
  return { ...resolvedBase, ...rendererArgs, ...analyzeSettingArgs(settings) }
}

