import React from 'react'
import { RECORDING_RANGES, type RecordingSettings } from '../../shared/recording'
import { recordingI18n as t } from '../i18n/zh-TW'
import { GainControl, NumberField, SegmentedControl, SelectControl, SwitchControl, describedBy, type ControlIds } from './SettingControls'
import type { SettingsController, SettingsState } from './settingsController'
import { fillTemplate } from './settingsModel'

const BOOL_FIELDS = ['autoRecord', 'launchAtLogin', 'closeToTray', 'micEnabled', 'notifyMatch', 'forceAspect', 'systemAudioEnabled', 'gameAudioOnly', 'micMono'] as const
const BITRATES = [5000, 8000, 10000, 15000, 20000, 30000, 40000, 50000, 60000, 80000, 100000, 150000]

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
  if (field === 'fps' || field === 'aspectMode') {
    const options = field === 'fps' ? [10, 20, 30, 60, 90, 120].map((v) => ({ value: String(v), label: String(v) }))
      : [{ value: 'fit', label: t.fit }, { value: 'stretch', label: t.stretch }]
    return <SegmentedControl ids={ids} value={String(settings[field])} options={options}
      disabled={field === 'aspectMode' && !settings.forceAspect}
      onChange={(v) => field === 'fps' ? set('fps', Number(v) as RecordingSettings['fps']) : set('aspectMode', v as RecordingSettings['aspectMode'])} />
  }
  if (field === 'systemGain' || field === 'micGain') {
    return <GainControl ids={ids} value={settings[field]} syncKey={state.settings}
      disabled={field === 'systemGain' ? !settings.systemAudioEnabled : !settings.micEnabled} onCommit={(v) => set(field, v)} />
  }
  if (field === 'diskWarnGb' || field === 'diskStopGb') {
    const range = RECORDING_RANGES[field]
    return <NumberField id={ids.ctl} value={settings[field]} range={range} syncKey={state.settings}
      describedBy={describedBy(ids)} unit="GB" onCommit={(v) => controller.setRecording(field, v)} />
  }
  const caps = state.recordingCapabilities
  let options: Array<{ value: string; label: string; disabled?: boolean }>
  switch (field) {
    case 'mode':
      options = [{ value: 'session', label: t.session }, { value: 'match', label: t.match }]
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
      options = [{ value: '0', label: t.native }, { value: '720', label: '720p (HD)' },
        { value: '1080', label: '1080p (Full HD)' }, { value: '1440', label: '1440p (2K)' }]
      break
    case 'bitrateKbps':
      options = BITRATES.map((v) => ({ value: String(v), label: String(v) }))
      if (!BITRATES.includes(settings.bitrateKbps)) options.push({ value: String(settings.bitrateKbps), label: fillTemplate(t.current, { value: settings.bitrateKbps }) })
      break
    case 'preset':
      options = [{ value: 'speed', label: t.speed }, { value: 'balanced', label: t.balanced }, { value: 'quality', label: t.quality }]
      break
    case 'captureMethod':
      options = [{ value: 'wgc', label: t.captureWgc }, { value: 'dda', label: t.captureDda }]
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
    <div className="set-inline set-recording-select">
      <SelectControl ids={{ ...ids, reason: hint ? `${ids.ctl}-capabilities` : ids.reason }} value={current} options={options}
        disabled={field === 'renderDevice' ? !settings.systemAudioEnabled || settings.gameAudioOnly : field === 'captureDevice' && !settings.micEnabled}
        onChange={(v) => {
          if (field === 'height' || field === 'bitrateKbps') set(field, Number(v) as RecordingSettings[typeof field])
          else if (field === 'codec') {
            set('codec', v as RecordingSettings['codec'])
            set('encoder', 'auto')
          } else set(field, v as RecordingSettings[typeof field])
        }} />
      {hint && <small id={`${ids.ctl}-capabilities`} className="set-desc" role="status">{hint}</small>}
    </div>
  )
}
