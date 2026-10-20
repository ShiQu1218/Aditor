// Single source of truth for recording quality options, shared by RecordingControl and onboarding.
import { recordingI18n } from '../i18n'
import { fillTemplate } from './settingsModel'

export interface ChoiceOption {
  value: string
  label: string
}

/** Frame rate options (fps). */
export const FPS_OPTIONS: readonly number[] = [10, 20, 30, 60, 90, 120]

/** Bitrate options (kbps). */
export const BITRATE_OPTIONS: readonly number[] = [5000, 8000, 10000, 15000, 20000, 30000, 40000, 50000, 60000, 80000, 100000, 150000]

/** Resolution options: 0 means native resolution (no scaling). */
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

/** Bitrate options; append a "Current: …" option when the current value is missing from the list. */
export function bitrateOptions(current?: number): ChoiceOption[] {
  const options = BITRATE_OPTIONS.map((v) => ({ value: String(v), label: String(v) }))
  if (current !== undefined && !BITRATE_OPTIONS.includes(current)) {
    options.push({ value: String(current), label: fillTemplate(recordingI18n.current, { value: current }) })
  }
  return options
}
