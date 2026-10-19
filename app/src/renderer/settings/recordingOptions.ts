// 錄影畫質選項的唯一來源：設定頁的 RecordingControl 與首次啟動引導共用，避免兩份清單。
import { recordingI18n } from '../i18n'
import { fillTemplate } from './settingsModel'

export interface ChoiceOption {
  value: string
  label: string
}

/** 影格率選項（fps）。 */
export const FPS_OPTIONS: readonly number[] = [10, 20, 30, 60, 90, 120]

/** 位元率選項（kbps）。 */
export const BITRATE_OPTIONS: readonly number[] = [5000, 8000, 10000, 15000, 20000, 30000, 40000, 50000, 60000, 80000, 100000, 150000]

/** 解析度選項：0＝原生（不縮放）。 */
export function heightOptions(): ChoiceOption[] {
  return [
    { value: '0', label: recordingI18n.native },
    { value: '720', label: '720p (HD)' },
    { value: '1080', label: '1080p (Full HD)' },
    { value: '1440', label: '1440p (2K)' }
  ]
}

export function fpsOptions(): ChoiceOption[] {
  return FPS_OPTIONS.map((v) => ({ value: String(v), label: String(v) }))
}

/** 位元率選項；目前值不在清單內時附加一個「目前：…」選項，避免下拉選單顯示成別的值。 */
export function bitrateOptions(current?: number): ChoiceOption[] {
  const options = BITRATE_OPTIONS.map((v) => ({ value: String(v), label: String(v) }))
  if (current !== undefined && !BITRATE_OPTIONS.includes(current)) {
    options.push({ value: String(current), label: fillTemplate(recordingI18n.current, { value: current }) })
  }
  return options
}
