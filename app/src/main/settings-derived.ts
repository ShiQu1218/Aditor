import { DEFAULT_SETTINGS, Settings } from '../shared/settings'

/** Minimal shape of settings fields that affect engine analyze (decode/cacheLocation). */
export type AnalyzeSettings = Pick<Settings, 'decode' | 'cacheLocation'>

/** decode=software → hwaccel:false; cacheLocation=besideVideo → beside:true (engine IPC `analyze` arguments). */
export function analyzeSettingArgs(s: AnalyzeSettings | undefined): { hwaccel: boolean; beside: boolean } {
  const cur = s ?? DEFAULT_SETTINGS
  return { hwaccel: cur.decode !== 'software', beside: cur.cacheLocation === 'besideVideo' }
}
