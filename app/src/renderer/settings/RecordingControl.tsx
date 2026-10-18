import React from 'react'
import { RECORDING_RANGES, type RecordingSettings } from '../../shared/recording'
import { recordingI18n as t } from '../i18n/zh-TW'
import { NumberField, SelectControl, SwitchControl, describedBy, type ControlIds } from './SettingControls'
import type { SettingsController, SettingsState } from './settingsController'
import { fillTemplate } from './settingsModel'

const BOOL_FIELDS = ['autoRecord', 'launchAtLogin', 'closeToTray', 'micEnabled', 'notifyMatch'] as const

export function RecordingControl({ field, ids, state, settings, controller }: {
  field: keyof RecordingSettings
  ids: ControlIds
  state: SettingsState
  settings: RecordingSettings
  controller: SettingsController
}): JSX.Element | null {
  const set = <K extends keyof RecordingSettings>(key: K, value: RecordingSettings[K]): void => {
    void controller.setRecording(key, value)
  }
  if ((BOOL_FIELDS as readonly string[]).includes(field)) {
    const key = field as typeof BOOL_FIELDS[number]
    return <SwitchControl ids={ids} checked={settings[key]} onChange={(v) => set(key, v)} />
  }
  if (field === 'outputDir') {
    return (
      <div className="set-inline">
        <span className="set-value mono" title={settings.outputDir ?? undefined}>{settings.outputDir ?? t.defaultDir}</span>
        <button id={ids.ctl} type="button" className="set-btn sm" aria-describedby={describedBy(ids)} onClick={() => void controller.pickRecordingDir()}>{t.choose}</button>
        {settings.outputDir && <button type="button" className="set-btn ghost sm" onClick={() => set('outputDir', null)}>{t.clear}</button>}
      </div>
    )
  }
  if (field === 'bitrateKbps' || field === 'micGain' || field === 'diskWarnGb' || field === 'diskStopGb') {
    const factor = field === 'bitrateKbps' ? 0.001 : field === 'micGain' ? 100 : 1
    const range = RECORDING_RANGES[field]
    return <NumberField id={ids.ctl} value={settings[field] * factor}
      range={{ min: range.min * factor, max: range.max * factor }} syncKey={state.settings}
      describedBy={describedBy(ids)} unit={field === 'bitrateKbps' ? 'Mbps' : field === 'micGain' ? '%' : 'GB'}
      onCommit={(v) => controller.setRecording(field, v / factor)} />
  }
  const caps = state.recordingCapabilities
  let options: Array<{ value: string; label: string; disabled?: boolean }>
  switch (field) {
    case 'mode':
      options = [{ value: 'session', label: t.session }, { value: 'match', label: t.matchUnavailable, disabled: true }]
      break
    case 'codec':
      options = [{ value: 'hevc', label: 'HEVC' }, { value: 'h264', label: 'H.264' }, { value: 'av1', label: 'AV1' }]
      break
    case 'encoder':
      options = [{ value: 'auto', label: t.auto }, ...(caps.value?.encoders ?? [])
        .filter((name) => name.startsWith(`${settings.codec}_`)).map((name) => ({ value: name, label: name }))]
      break
    case 'renderDevice':
    case 'captureDevice':
      options = [{ value: 'default', label: t.defaultDevice }, ...(caps.value?.audio[field === 'renderDevice' ? 'render' : 'capture'] ?? [])
        .filter((device) => device.id !== 'default').map((device) => ({ value: device.id, label: device.name }))]
      break
    case 'height':
      options = [0, 1440, 1080, 720].map((value) => ({ value: String(value), label: value === 0 ? t.native : `${value}p` }))
      break
    case 'fps':
      options = [30, 60, 120, 144].map((value) => ({ value: String(value), label: String(value) }))
      break
    case 'postAnalysis':
      options = [{ value: 'none', label: t.analysisNone }, { value: 'afterExit', label: t.analysisAfterExit }, { value: 'perMatch', label: t.analysisPerMatch }]
      break
    default:
      return null
  }
  const current = String(settings[field])
  // 未連接裝置仍保留已儲存的值；不因能力探測失敗寫入預設值。
  const missing = !options.some((o) => o.value === current)
  if (missing) options.push({ value: current, label: fillTemplate(t.currentUnavailable, { value: current }), disabled: true })
  const hint = field === 'encoder' && !caps.value ? caps.loading ? t.capabilitiesLoading : t.capabilitiesUnavailable : undefined
  return (
    <div className="set-inline">
      <SelectControl ids={{ ...ids, reason: hint ? `${ids.ctl}-capabilities` : ids.reason }} value={current} options={options}
        onChange={(v) => {
          if (field === 'height' || field === 'fps') set(field, Number(v) as RecordingSettings[typeof field])
          else if (field === 'codec') {
            set('codec', v as RecordingSettings['codec'])
            set('encoder', 'auto')
          } else set(field, v as RecordingSettings[typeof field])
        }} />
      {hint && <small id={`${ids.ctl}-capabilities`} className="set-desc" role="status">{hint}</small>}
    </div>
  )
}
