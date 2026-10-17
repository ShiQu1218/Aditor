import React, { useEffect, useRef, useState } from 'react'
import { SETTINGS_RANGES, type Settings, type SettingsRange } from '../../shared/settings'
import type { AutoClipParams } from '../../shared/types'
import { FolderOpen, Plus, RefreshCw, Trash2, X } from '../components/icons'
import { settingsI18n } from '../i18n/zh-TW'
import { clampToRange, fillTemplate, formatBytes } from './settingsModel'
import type { SettingsController, SettingsState } from './settingsController'
import type { SettingRow } from './rows'

const t = settingsI18n.row

/** 控制項共用的 aria 對應：id（label for）、說明與原因（aria-describedby）。 */
export interface ControlIds {
  ctl: string
  title: string
  desc?: string
  reason?: string
  err?: string
}

export const describedBy = (ids: ControlIds, extra?: string): string | undefined =>
  [ids.desc, ids.reason, ids.err, extra].filter(Boolean).join(' ') || undefined

/** 真正的 checkbox（role=switch）：由 <label for> 命名，樣式為開關。 */
export function SwitchControl(props: {
  ids: ControlIds
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}): JSX.Element {
  return (
    <input
      id={props.ids.ctl}
      type="checkbox"
      role="switch"
      className="set-switch"
      checked={props.checked}
      disabled={props.disabled}
      aria-describedby={describedBy(props.ids)}
      onChange={(e) => props.onChange(e.target.checked)}
    />
  )
}

export function SelectControl(props: {
  ids: ControlIds
  value: string
  options: ReadonlyArray<{ value: string; label: string }>
  onChange: (v: string) => void
}): JSX.Element {
  return (
    <select
      id={props.ids.ctl}
      className="set-select"
      value={props.value}
      aria-describedby={describedBy(props.ids)}
      onChange={(e) => props.onChange(e.target.value)}
    >
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

/**
 * 數字框＋−／＋按鈕：輸入中保留使用者鍵入的草稿，失焦／Enter／按鈕時才夾限並送出；
 * 送出後草稿一律回到「main 回傳的值」（syncKey 變動＝收到新的設定）。
 */
export function NumberField(props: {
  id: string
  value: number
  range: SettingsRange
  /** 收到新的設定時變動（用來把草稿還原成真實值） */
  syncKey: unknown
  ariaLabel?: string
  labelledBy?: string
  describedBy?: string
  unit?: string
  stepperLabels?: { dec: string; inc: string }
  onCommit: (v: number) => void | Promise<void>
}): JSX.Element {
  const { value, range } = props
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value, props.syncKey])

  const commit = (raw: string): void => {
    const n = raw.trim() === '' ? Number.NaN : Number(raw)
    const v = clampToRange(range, n)
    if (v === null) {
      setDraft(String(value)) // 無法解析：還原
      return
    }
    setDraft(String(v))
    if (v !== value) void props.onCommit(v)
  }
  const bump = (delta: number): void => commit(String((Number(draft) || value) + delta))

  return (
    <span className="set-stepper">
      {props.stepperLabels && (
        <button type="button" className="set-step" aria-label={props.stepperLabels.dec} onClick={() => bump(-1)}>
          −
        </button>
      )}
      <input
        id={props.id}
        type="number"
        className="set-num"
        inputMode="numeric"
        min={range.min}
        max={range.max}
        step={1}
        value={draft}
        aria-label={props.ariaLabel}
        aria-labelledby={props.labelledBy}
        aria-describedby={props.describedBy}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) commit((e.target as HTMLInputElement).value)
        }}
      />
      {props.unit && <span className="set-unit">{props.unit}</span>}
      {props.stepperLabels && (
        <button type="button" className="set-step" aria-label={props.stepperLabels.inc} onClick={() => bump(1)}>
          +
        </button>
      )}
    </span>
  )
}

interface ControlProps {
  row: SettingRow
  ids: ControlIds
  state: SettingsState
  settings: Settings
  controller: SettingsController
  disabled: boolean
}

const AUTOCLIP_KEYS: ReadonlyArray<keyof AutoClipParams> = ['n', 'gap', 'before', 'after', 'max_len']

function ProxyUsageControl({ ids, state, controller }: ControlProps): JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const [result, setResult] = useState('')
  const [busy, setBusy] = useState(false)
  const { proxy } = state
  const summary =
    proxy.status === 'error'
      ? t.proxyUsage.unknown
      : proxy.status === 'loading' || proxy.status === 'idle'
        ? '…'
        : proxy.count === 0
          ? t.proxyUsage.none
          : fillTemplate(t.proxyUsage.summary, { size: formatBytes(proxy.bytes), count: proxy.count })
  const canDelete = proxy.status === 'ready' && proxy.count > 0 && !busy
  const run = async (): Promise<void> => {
    setBusy(true)
    setConfirming(false)
    const res = await controller.deleteProxies()
    setBusy(false)
    setResult(
      res.failed > 0
        ? fillTemplate(t.proxyUsage.failed, { n: res.failed })
        : fillTemplate(t.proxyUsage.deleted, { n: res.deleted })
    )
  }
  return (
    <div className="set-inline">
      <span className="set-value" id={`${ids.ctl}-summary`}>
        {summary}
      </span>
      {confirming ? (
        <>
          <button type="button" className="set-btn sm danger" onClick={() => void run()}>
            {t.proxyUsage.confirm}
          </button>
          <button type="button" className="set-btn sm" onClick={() => setConfirming(false)}>
            {t.proxyUsage.cancel}
          </button>
        </>
      ) : (
        <button
          id={ids.ctl}
          type="button"
          className="set-btn sm danger"
          disabled={!canDelete}
          aria-describedby={describedBy(ids, `${ids.ctl}-summary`)}
          onClick={() => setConfirming(true)}
        >
          <Trash2 className="ic sm" />
          {t.proxyUsage.delete}
        </button>
      )}
      <span className="set-sr-live" role="status" aria-live="polite">
        {result}
      </span>
    </div>
  )
}

export function SettingControl(props: ControlProps): JSX.Element | null {
  const { row, ids, state, settings, controller } = props
  const c = row.control
  switch (c.kind) {
    case 'switch':
      return (
        <SwitchControl
          ids={ids}
          checked={settings[c.field]}
          disabled={props.disabled}
          onChange={(v) => void controller.setBool(c.field, v)}
        />
      )
    case 'select':
      return (
        <SelectControl
          ids={ids}
          value={settings[c.field]}
          options={c.options}
          onChange={(v) => void controller.setEnum(c.field, v)}
        />
      )
    case 'numberPair': {
      const names = { before: t.beforeAfter.before, after: t.beforeAfter.after } as const
      return (
        <span className="set-pair" role="group" aria-labelledby={ids.title} aria-describedby={describedBy(ids)}>
          {c.fields.map((f) => (
            <NumberField
              key={f}
              id={`${ids.ctl}-${f}`}
              value={settings[f]}
              range={SETTINGS_RANGES[f]}
              syncKey={settings}
              ariaLabel={names[f]}
              unit={t.beforeAfter.unit}
              stepperLabels={{
                dec: fillTemplate(t.beforeAfter.decrease, { name: names[f] }),
                inc: fillTemplate(t.beforeAfter.increase, { name: names[f] })
              }}
              onCommit={(v) => controller.setNumber(f, v)}
            />
          ))}
        </span>
      )
    }
    case 'autoclip':
      return (
        <div className="set-autoclip" role="group" aria-labelledby={ids.title} aria-describedby={describedBy(ids)}>
          {AUTOCLIP_KEYS.map((k) => {
            const id = `${ids.ctl}-${k}`
            return (
              <div className="set-field" key={k}>
                <label htmlFor={id}>{t.autoclip[k]}</label>
                <NumberField
                  id={id}
                  value={settings.autoclip[k]}
                  range={SETTINGS_RANGES.autoclip[k]}
                  syncKey={settings}
                  onCommit={(v) => controller.setAutoclip(k, v)}
                />
              </div>
            )
          })}
        </div>
      )
    case 'watchFolders': {
      const { dirs, missing } = state.watch
      const missingKeys = new Set(missing.map((d) => d.toLowerCase()))
      return (
        <div className="set-watch">
          {dirs.length === 0 ? (
            <p className="set-empty">{t.watchFolders.empty}</p>
          ) : (
            <ul className="set-dirs" aria-label={t.watchFolders.list}>
              {dirs.map((d) => (
                <li key={d}>
                  <span className="set-dir mono" title={d}>
                    {d}
                  </span>
                  {missingKeys.has(d.toLowerCase()) && <span className="set-chip warn">{t.watchFolders.missing}</span>}
                  <button
                    type="button"
                    className="set-btn ghost sm"
                    aria-label={fillTemplate(t.watchFolders.removeLabel, { dir: d })}
                    onClick={() => void controller.removeWatchFolder(d)}
                  >
                    <X className="ic sm" />
                    {t.watchFolders.remove}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            id={ids.ctl}
            type="button"
            className="set-btn sm"
            aria-describedby={describedBy(ids)}
            onClick={() => void controller.addWatchFolder()}
          >
            <Plus className="ic sm" />
            {t.watchFolders.add}
          </button>
        </div>
      )
    }
    case 'proxyUsage':
      return <ProxyUsageControl {...props} />
    case 'outDir': {
      const dir = settings.defaultOutDir
      return (
        <div className="set-inline">
          <span className="set-value mono" title={dir ?? undefined}>
            {dir ?? t.defaultOutDir.unset}
          </span>
          <button
            id={ids.ctl}
            type="button"
            className="set-btn sm"
            aria-describedby={describedBy(ids)}
            onClick={() => void controller.pickOutDir()}
          >
            <FolderOpen className="ic sm" />
            {t.defaultOutDir.choose}
          </button>
          {dir && (
            <button type="button" className="set-btn ghost sm" onClick={() => void controller.clearOutDir()}>
              {t.defaultOutDir.clear}
            </button>
          )}
        </div>
      )
    }
    case 'encoders': {
      const { status, list } = state.encoders
      const items: Array<[string, string]> = [
        ['NVENC', 'h264_nvenc'],
        ['QSV', 'h264_qsv'],
        ['AMF', 'h264_amf']
      ]
      return (
        <div className="set-inline">
          <span className="set-value" id={`${ids.ctl}-list`}>
            {status === 'idle' || (status === 'loading' && list.length === 0)
              ? status === 'idle'
                ? t.encoders.notDetected
                : t.encoders.detecting
              : items.map(([label, name]) => {
                  const ok = list.includes(name)
                  return (
                    <span key={name} className={`set-enc${ok ? ' ok' : ''}`}>
                      {`${label} ${ok ? '✓' : '✗'}`}
                      <span className="set-sr">{ok ? t.encoders.available : t.encoders.unavailable}</span>
                    </span>
                  )
                })}
          </span>
          <button
            id={ids.ctl}
            type="button"
            className="set-btn sm"
            disabled={status === 'loading'}
            aria-describedby={describedBy(ids, `${ids.ctl}-list`)}
            onClick={() => void controller.refreshEncoders()}
          >
            <RefreshCw className="ic sm" />
            {t.encoders.redetect}
          </button>
        </div>
      )
    }
    case 'openh264': {
      const st = state.openh264
      const dl = state.openh264Download
      const busy = dl.step === 'downloading'
      const pct = Math.round(dl.ratio * 100)
      return (
        <div className="set-inline">
          <span className="set-value">
            {busy
              ? fillTemplate(t.openh264.downloading, { pct: String(pct) })
              : st === null
                ? t.openh264.unknown
                : st
                  ? t.openh264.installed
                  : t.openh264.notInstalled}
          </span>
          {dl.step === 'consent' ? (
            <>
              <span className="set-value wrap" role="note">
                {t.openh264.consent}
              </span>
              <button type="button" className="set-btn sm" onClick={() => void controller.confirmOpenH264Download()}>
                {t.openh264.accept}
              </button>
              <button type="button" className="set-btn sm ghost" onClick={() => controller.cancelOpenH264Download()}>
                {t.openh264.decline}
              </button>
            </>
          ) : (
            <button
              id={ids.ctl}
              type="button"
              className="set-btn sm"
              disabled={busy}
              aria-describedby={describedBy(ids)}
              onClick={() => controller.requestOpenH264Download()}
            >
              {st ? t.openh264.redownload : t.openh264.download}
            </button>
          )}
          {dl.step === 'error' && (
            <span className="set-err" role="alert">
              {fillTemplate(t.openh264.failed, { msg: dl.error ?? '' })}
            </span>
          )}
        </div>
      )
    }
    case 'about':
      return (
        <div className="set-inline">
          <span className="set-value">{fillTemplate(t.about.version, { version: appVersion() })}</span>
          <button
            id={ids.ctl}
            type="button"
            className="set-btn sm"
            aria-describedby={describedBy(ids)}
            onClick={() => void window.api?.app?.openLicenses?.()}
          >
            {t.about.licenses}
          </button>
        </div>
      )
    case 'none':
      return null
  }
}

declare const __APP_VERSION__: string | undefined

function appVersion(): string {
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''
}
