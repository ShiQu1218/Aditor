import React, { useEffect, useRef, useState } from 'react'
import { RECORDING_RANGES, type RecordingSettings } from '../../shared/recording'
import { useFocusTrap } from '../a11y/useFocusTrap'
import { recordingI18n as t } from '../i18n'
import { GainControl, NumberField, SegmentedControl, SelectControl, SwitchControl, describedBy, type ControlIds } from './SettingControls'
import type { SettingsController, SettingsState } from './settingsController'
import { fillTemplate } from './settingsModel'
import { bitrateOptions, fpsOptions, heightOptions } from './recordingOptions'

const BOOL_FIELDS = ['autoRecord', 'launchAtLogin', 'closeToTray', 'micEnabled', 'notifyMatch', 'openOnGameExit', 'forceAspect', 'systemAudioEnabled', 'gameAudioOnly', 'micMono', 'obsFallbackBuiltin'] as const
const HOOK_WARN_SECONDS = 5

function CaptureHookWarningDialog({ selectId, onCancel, onConfirm }: {
  selectId: string
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  const w = t.captureHookWarning
  const [remaining, setRemaining] = useState(HOOK_WARN_SECONDS)
  const boxRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const sections = [w.sections.diff, w.sections.how, w.sections.risk, w.sections.disclaimer]

  useFocusTrap(boxRef, {
    onEscape: onCancel,
    initialFocus: () => cancelRef.current,
    returnFocusTo: () => document.getElementById(selectId)
  })

  useEffect(() => {
    const timer = setInterval(() => {
      setRemaining((s) => {
        if (s <= 1) {
          clearInterval(timer)
          return 0
        }
        return s - 1
      })
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className="set-dlg-scrim" onClick={onCancel}>
      <div
        ref={boxRef}
        className="set-dlg"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="set-capture-hook-warn-title"
        aria-describedby="set-capture-hook-warn-desc"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="set-capture-hook-warn-title">{w.title}</h3>
        <div id="set-capture-hook-warn-desc" className="set-dlg-body" tabIndex={0}>
          {sections.map((sec) => (
            <section key={sec.heading} className="set-dlg-sec">
              <h4>{sec.heading}</h4>
              {'items' in sec ? (
                <ul>
                  {sec.items.map((item, i) => <li key={i}>{item}</li>)}
                </ul>
              ) : (
                <p>{sec.text}</p>
              )}
            </section>
          ))}
        </div>
        <div className="set-dlg-foot">
          <button id="set-recording-captureHook-cancel" ref={cancelRef} type="button" className="set-btn ghost" onClick={onCancel}>
            {w.cancel}
          </button>
          <button
            id="set-recording-captureHook-confirm"
            type="button"
            className="set-btn danger"
            disabled={remaining > 0}
            onClick={() => {
              if (remaining <= 0) onConfirm()
            }}
          >
            {remaining > 0 ? fillTemplate(w.confirmCountdown, { sec: remaining }) : w.confirm}
          </button>
        </div>
      </div>
    </div>
  )
}

function ObsTextControl({ field, ids, state, settings, controller }: {
  field: 'obsHost' | 'obsPassword'; ids: ControlIds; state: SettingsState; settings: RecordingSettings; controller: SettingsController
}): JSX.Element {
  const password = field === 'obsPassword'
  const [value, setValue] = useState(password ? '' : settings.obsHost)
  useEffect(() => { if (!password) setValue(settings.obsHost) }, [password, settings])
  const save = (): void => {
    if (password) {
      if (value) void controller.setRecording('obsPassword', value).then(() => setValue(''))
    } else if (value !== settings.obsHost) void controller.setRecording('obsHost', value)
  }
  const { testing, result } = state.obsConnection
  return <div className="set-inline">
    <input id={ids.ctl} className="set-input" type={password ? 'password' : 'text'} value={value} maxLength={password ? 4096 : 253}
      aria-describedby={describedBy(ids)} autoComplete={password ? 'new-password' : 'off'}
      placeholder={password ? settings.hasPassword ? t.obsPasswordSet : t.obsPasswordEmpty : undefined}
      onChange={(e) => setValue(e.target.value)} onBlur={() => { if (!password) save() }}
      onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); save() } }} />
    {password ? <>
      <button type="button" className="set-btn sm" disabled={!value} onClick={save}>{t.obsPasswordSave}</button>
      {settings.hasPassword && <button type="button" className="set-btn ghost sm" onClick={() => void controller.setRecording('obsPassword', '')}>{t.obsPasswordClear}</button>}
    </> : <>
      <button type="button" className="set-btn sm" disabled={testing} onClick={() => void controller.testObs()}>{testing ? t.obsTesting : t.obsTest}</button>
      {result && <small className="set-desc" role={result.ok ? 'status' : 'alert'}>{result.ok
        ? `OBS ${result.obsVersion} · obs-websocket ${result.obsWebSocketVersion}` : result.error}</small>}
    </>}
  </div>
}

export function RecordingControl({ field, ids, state, settings, controller }: {
  field: keyof RecordingSettings
  ids: ControlIds
  state: SettingsState
  settings: RecordingSettings
  controller: SettingsController
}): JSX.Element | null {
  const [hookWarnOpen, setHookWarnOpen] = useState(false)
  const set = <K extends keyof RecordingSettings>(key: K, value: RecordingSettings[K]): void => {
    void controller.setRecording(key, value)
  }
  if (field === 'obsHost' || field === 'obsPassword') return <ObsTextControl field={field} ids={ids} state={state} settings={settings} controller={controller} />
  if (field === 'obsPort') return <NumberField id={ids.ctl} value={settings.obsPort} range={{ min: 1, max: 65535 }} syncKey={state.settings}
    describedBy={describedBy(ids)} onCommit={(v) => controller.setRecording('obsPort', Math.round(v))} />
  if ((BOOL_FIELDS as readonly string[]).includes(field)) {
    const key = field as typeof BOOL_FIELDS[number]
    return <SwitchControl ids={ids} checked={settings[key]} onChange={(v) => set(key, v)} />
  }
  if (field === 'fps' || field === 'aspectMode') {
    const options = field === 'fps' ? fpsOptions()
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
    case 'backend':
      options = [{ value: 'builtin', label: t.builtin }, { value: 'obs', label: t.obs }]
      break
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
      options = heightOptions()
      break
    case 'bitrateKbps':
      options = bitrateOptions(settings.bitrateKbps)
      break
    case 'preset':
      options = [{ value: 'speed', label: t.speed }, { value: 'balanced', label: t.balanced }, { value: 'quality', label: t.quality }]
      break
    case 'captureMethod':
      options = [{ value: 'hook', label: t.captureHook }, { value: 'dda', label: t.captureDda }, { value: 'wgc', label: t.captureWgc }]
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
          } else if (field === 'captureMethod' && v === 'hook') {
            if (settings.captureMethod !== 'hook') setHookWarnOpen(true)
          } else set(field, v as RecordingSettings[typeof field])
        }} />
      {hint && <small id={`${ids.ctl}-capabilities`} className="set-desc" role="status">{hint}</small>}
      {field === 'backend' && settings.backend === 'obs' && <small className="set-desc">{t.obsHint}</small>}
      {field === 'captureMethod' && hookWarnOpen && (
        <CaptureHookWarningDialog
          selectId={ids.ctl}
          onCancel={() => setHookWarnOpen(false)}
          onConfirm={() => {
            setHookWarnOpen(false)
            set('captureMethod', 'hook')
          }}
        />
      )}
    </div>
  )
}
