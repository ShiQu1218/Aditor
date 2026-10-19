import { DEFAULT_SETTINGS, Settings } from '../shared/settings'

/** Minimal shape of settings fields that affect engine analyze (decode/cacheLocation). */
export type AnalyzeSettings = Pick<Settings, 'decode' | 'cacheLocation'>

/** decode=software → hwaccel:false; cacheLocation=besideVideo → beside:true (engine IPC `analyze` arguments). */
export function analyzeSettingArgs(s: AnalyzeSettings | undefined): { hwaccel: boolean; beside: boolean } {
  const cur = s ?? DEFAULT_SETTINGS
  return { hwaccel: cur.decode !== 'software', beside: cur.cacheLocation === 'besideVideo' }
}

/**
 * Build an analyze request using renderer fields (path/force) as the base, then override them with main-selected values
 * (profile_dir/cache_dir) and settings-derived hwaccel/beside—the renderer cannot choose the profile or cache directory (defense in depth beyond sanitizeAnalyzeArgs).
 */
export function buildAnalyzeArgs(
  base: Record<string, unknown>,
  settings: AnalyzeSettings | undefined,
  rendererArgs: Record<string, unknown>
): Record<string, unknown> {
  return { ...rendererArgs, ...base, ...analyzeSettingArgs(settings) }
}
