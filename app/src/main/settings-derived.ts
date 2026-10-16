import { DEFAULT_SETTINGS, Settings } from '../shared/settings'

/** 設定中影響引擎 analyze 的欄位（decode／cacheLocation）的最小形狀。 */
export type AnalyzeSettings = Pick<Settings, 'decode' | 'cacheLocation'>

/** decode=software → hwaccel:false；cacheLocation=besideVideo → beside:true（引擎 ipc `analyze` 參數）。 */
export function analyzeSettingArgs(s: AnalyzeSettings | undefined): { hwaccel: boolean; beside: boolean } {
  const cur = s ?? DEFAULT_SETTINGS
  return { hwaccel: cur.decode !== 'software', beside: cur.cacheLocation === 'besideVideo' }
}

/** 組 analyze 請求：以 base 為底、疊上 renderer 傳來的欄位，但 hwaccel／beside 一律以設定為準。 */
export function buildAnalyzeArgs(
  base: Record<string, unknown>,
  settings: AnalyzeSettings | undefined,
  rendererArgs: Record<string, unknown>
): Record<string, unknown> {
  return { ...base, ...rendererArgs, ...analyzeSettingArgs(settings) }
}
