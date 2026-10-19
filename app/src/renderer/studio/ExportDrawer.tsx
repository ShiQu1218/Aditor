import React, { useEffect, useRef, useSyncExternalStore } from 'react'
import '../styles/exportDrawer.css'
import { i18n } from '../i18n'
import { formatTime } from '../../shared/time'
import { tr } from '../../shared/locale'
import { exportSubDirName, joinForDisplay } from '../../shared/storage'
import { estimateOutputBytes } from '../../shared/exportEstimate'
import { totalDuration, Project } from '../editor/project'
import { Check, Copy, Download, FolderOpen, AlertTriangle, X } from '../components/icons'
import { ExportController, ExportItem, ExportState } from './exportController'
import { diskIsLow, ExportPlan, exportViewModel, ExportViewModel, formatBytes } from './exportViewModel'
import { OpenH264Dialog } from './OpenH264Dialog'
import { nextTrapIndex } from './focusTrap'

/** 來源探測結果（與目前設定無關的部分）；mode／quality 由抽屜依設定補上。 */
import type { ExportPlanBase } from './exportPlanBase'
export type { ExportPlanBase }

export interface ExportDrawerViewProps {
  state: ExportState
  vm: ExportViewModel
  project: Project
  items: ExportItem[]
  sourceCount: number
  on: {
    mode: (m: 'concat' | 'separate') => void
    quality: (q: 'copy' | 'precise') => void
    encoder: (e: string) => void
    baseName: (n: string) => void
    browse: () => void
    start: () => void
    cancelExport: () => void
    close: () => void
    minimize: () => void
    retry: () => void
    finish: () => void
    openFolder: () => void
    copyError: () => void
    declineConsent: () => void
    acceptConsent: () => void
  }
}

const fmt = (tpl: string, vars: Record<string, string | number>): string =>
  Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), tpl)

/** 編碼器的顯示名稱（不含「偵測到」之類的後綴）。 */
function encoderName(name: string): string {
  const nice: Record<string, string> = { h264_nvenc: 'NVIDIA NVENC', h264_qsv: 'Intel Quick Sync', h264_amf: 'AMD AMF' }
  return nice[name] ?? name
}

function encoderLabel(name: string): string {
  const t = i18n.export
  if (name === 'libopenh264') return t.encoderOpenh264
  return fmt(t.encoderDetected, { name: encoderName(name) })
}

function SettingsBody({ state, vm, project, items, sourceCount, on }: ExportDrawerViewProps): JSX.Element {
  const t = i18n.export
  const s = state.settings
  const total = totalDuration(project)
  const estimate = estimateOutputBytes({ items }, vm.effectiveQuality)
  const low = state.disk ? diskIsLow(state.disk.freeBytes, estimate) : false
  const drive = s.outDir && /^[A-Za-z]:/.test(s.outDir) ? s.outDir.slice(0, 2) : (s.outDir ?? '')
  const encoderOptions = state.encoders.length > 0 ? state.encoders : ['libopenh264']
  const hasHw = state.encoders.some((e) => e !== 'libopenh264')
  const copyHint = vm.copyAvailable
    ? [t.qualityCopyDesc, vm.extraSecondsHint !== null ? fmt(t.qualityCopyExtra, { sec: vm.extraSecondsHint.toFixed(1) }) : ''].filter(Boolean).join(' ')
    : t.qualityCopyUnavailable
  return (
    <>
      <div className="xd-stats">
        <div className="xd-stat">
          <b>{project.items.length}</b>
          <span>{t.summaryClips}</span>
        </div>
        <div className="xd-stat">
          <b>{formatTime(total)}</b>
          <span>{t.summaryDuration}</span>
        </div>
        <div className="xd-stat">
          <b>{sourceCount}</b>
          <span>{t.summarySources}</span>
        </div>
      </div>

      <div className="xd-live" aria-live="polite">
        {vm.notices.map((n, i) => (
          <div key={i} className={`xd-notice xd-${n.kind}`}>
            <AlertTriangle className="ic" aria-hidden="true" />
            <div>{n.text}</div>
          </div>
        ))}
        {(vm.blockers.length > 0 || state.outDirError) && (
          <div className="xd-notice xd-err" role="alert">
            <AlertTriangle className="ic" aria-hidden="true" />
            <div>
              <b>{t.blockersTitle}</b>
              <ul className="xd-blockers">
                {vm.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
                {state.outDirError && <li>{state.outDirError}</li>}
              </ul>
            </div>
          </div>
        )}
        {vm.openh264Required && (
          <div className="xd-notice xd-warn">
            <AlertTriangle className="ic" aria-hidden="true" />
            <div>{t.needOpenh264}</div>
          </div>
        )}
      </div>

      <fieldset className="xd-sec">
        <legend>{t.mode}</legend>
        <label className={`xd-opt${s.mode === 'concat' ? ' on' : ''}`}>
          <input type="radio" name="xd-mode" checked={s.mode === 'concat'} onChange={() => on.mode('concat')} />
          <div>
            <b>{t.modeConcat}</b>
            <small>{t.modeConcatDesc}</small>
          </div>
        </label>
        <label className={`xd-opt${s.mode === 'separate' ? ' on' : ''}`}>
          <input type="radio" name="xd-mode" checked={s.mode === 'separate'} onChange={() => on.mode('separate')} />
          <div>
            <b>{t.modeSeparate}</b>
            <small>{fmt(t.modeSeparateDesc, { n: project.items.length })}</small>
          </div>
        </label>
      </fieldset>

      <fieldset className="xd-sec">
        <legend>{t.quality}</legend>
        <label className={`xd-opt${vm.effectiveQuality === 'copy' ? ' on' : ''}${vm.copyAvailable ? '' : ' disabled'}`}>
          <input
            type="radio"
            name="xd-quality"
            checked={vm.effectiveQuality === 'copy'}
            disabled={!vm.copyAvailable}
            onChange={() => void on.quality('copy')}
          />
          <div>
            <b>
              {t.qualityCopy} {!vm.copyAvailable && <span className="xd-pill">{t.unavailable}</span>}
            </b>
            <small>{copyHint}</small>
          </div>
        </label>
        <label className={`xd-opt${vm.effectiveQuality === 'precise' ? ' on' : ''}`}>
          <input type="radio" name="xd-quality" checked={vm.effectiveQuality === 'precise'} onChange={() => void on.quality('precise')} />
          <div>
            <b>{t.qualityPrecise}</b>
            <small>{t.qualityPreciseDesc}</small>
          </div>
        </label>
        <select
          className="xd-select"
          aria-label={t.encoder}
          value={s.encoderChoice}
          onChange={(e) => on.encoder(e.target.value)}
        >
          <option value="auto">{t.encoderAuto}</option>
          {encoderOptions.map((e) => (
            <option key={e} value={e}>
              {e === 'libopenh264' && !state.openh264Installed && state.encoders.length === 0 ? t.encoderOpenh264Missing : encoderLabel(e)}
            </option>
          ))}
        </select>
        {!hasHw && <div className="xd-muted xd-hint">{t.encoderHint}</div>}
        {vm.effectiveQuality !== 'precise' && <div className="xd-muted xd-hint">{t.encoderCopyNote}</div>}
      </fieldset>

      <fieldset className="xd-sec">
        <legend>{t.output}</legend>
        <div className="xd-row">
          <input className="xd-input" readOnly value={s.outDir ?? ''} placeholder={t.outputDirPlaceholder} aria-label={t.outputDir} />
          <button type="button" className="btn-ghost" onClick={on.browse}>
            <FolderOpen className="ic sm" /> {t.browse}
          </button>
        </div>
        {s.outDir && (
          <div className="xd-muted xd-hint">{tr('實際會存到：{path}', { path: joinForDisplay(s.outDir, exportSubDirName(s.mode)) })}</div>
        )}
        <input
          className="xd-input"
          value={s.baseName}
          aria-label={t.baseName}
          maxLength={100}
          onChange={(e) => on.baseName(e.target.value)}
        />
        <div className="xd-muted xd-hint">
          {fmt(t.estimate, { size: formatBytes(estimate) })}
          {state.disk && ` · ${fmt(t.diskFree, { path: drive, size: formatBytes(state.disk.freeBytes) })}`}
        </div>
        {low && state.disk && (
          <div className="xd-notice xd-warn" role="alert">
            <AlertTriangle className="ic" aria-hidden="true" />
            <div>{fmt(t.diskLow, { need: formatBytes(estimate * 1.1), free: formatBytes(state.disk.freeBytes) })}</div>
          </div>
        )}
      </fieldset>
    </>
  )
}

function RunningBody({ state, vm }: Pick<ExportDrawerViewProps, 'state' | 'vm'>): JSX.Element {
  const t = i18n.export
  const p = state.progress ?? { percent: 0, jobIndex: 0, totalJobs: 1, outTimeSeconds: 0 }
  const enc = vm.effectiveQuality === 'copy' ? t.qualityCopy : (state.settings.encoder === 'libopenh264' ? t.encoderOpenh264 : encoderName(state.settings.encoder))
  return (
    <>
      <div className="xd-sec">
        <h4>{t.running}</h4>
        <div className="xd-big">{p.percent}%</div>
        <div className="xd-bar xd-bar-lg" role="progressbar" aria-label={t.running} aria-valuemin={0} aria-valuemax={100} aria-valuenow={p.percent}>
          <i style={{ width: `${p.percent}%` }} />
        </div>
        <div className="xd-muted">
          {fmt(t.runningDetail, { i: p.jobIndex + 1, n: p.totalJobs, sec: p.outTimeSeconds.toFixed(1), enc })}
        </div>
      </div>
      <div className="xd-muted">{t.runningLocked}</div>
    </>
  )
}

function DoneBody({ state, project }: Pick<ExportDrawerViewProps, 'state' | 'project'>): JSX.Element {
  const t = i18n.export
  const r = state.result!
  const took = `${Math.max(1, Math.round(r.durationMs / 1000))} ${t.sec}`
  return (
    <>
      <div className="xd-done-head">
        <Check className="ic xd-done-ic" aria-hidden="true" />
        <h3>{r.cancelled ? t.cancelledTitle : t.doneTitle}</h3>
        <div className="xd-muted">
          {r.cancelled ? t.cancelledDesc : fmt(t.doneSummary, { dur: formatTime(totalDuration(project)), took })}
        </div>
      </div>
      <div className="xd-sec">
        <h4>{t.outputFiles}</h4>
        <div className="xd-code" tabIndex={0}>
          {r.outputs.length > 0 ? r.outputs.join('\n') : t.cancelledNone}
        </div>
      </div>
      {r.notices.map((n, i) => (
        <div key={i} className="xd-notice xd-info">
          <AlertTriangle className="ic" aria-hidden="true" />
          <div>{n}</div>
        </div>
      ))}
    </>
  )
}

function FailedBody({ state }: Pick<ExportDrawerViewProps, 'state'>): JSX.Element {
  const t = i18n.export
  const r = state.result!
  return (
    <>
      <div className="xd-live" aria-live="assertive" role="alert">
        <div className="xd-notice xd-err">
          <AlertTriangle className="ic" aria-hidden="true" />
          <div>
            <b>{t.failedTitle}</b>　{t.failedDesc}
          </div>
        </div>
      </div>
      <div className="xd-sec">
        <h4>{t.stderrTitle}</h4>
        <div className="xd-code" tabIndex={0}>
          {r.error}
        </div>
      </div>
      <div className="xd-muted">{t.failedCauses}</div>
    </>
  )
}

/** 抽屜的純呈現（依 state／vm 渲染；不含副作用），供 renderToString 測試四個狀態。 */
export function ExportDrawerView(props: ExportDrawerViewProps & { drawerRef?: React.Ref<HTMLElement> }): JSX.Element {
  const { state, vm, on } = props
  const t = i18n.export
  const phase = state.phase
  // 需要 OpenH264 時按鈕仍可按（會開同意對話框）；其他阻擋條件一律停用
  const blocked = vm.blockers.length > 0 || !!state.outDirError || state.settings.baseName.trim() === '' || state.h264.step === 'downloading'
  const startDisabled = blocked || (!vm.canStart && !vm.openh264Required)
  return (
    <aside
      ref={props.drawerRef}
      className="xd"
      role="dialog"
      aria-modal="true"
      aria-labelledby="xd-title"
      data-phase={phase}
      tabIndex={-1}
    >
      <header className="xd-head">
        <h3 id="xd-title">{t.title}</h3>
        <button
          type="button"
          className="icon-btn"
          aria-label={phase === 'running' ? t.minimize : t.close}
          onClick={phase === 'running' ? on.minimize : on.close}
        >
          <X className="ic" />
        </button>
      </header>
      <div className="xd-body">
        {phase === 'settings' && <SettingsBody {...props} />}
        {phase === 'running' && <RunningBody state={state} vm={vm} />}
        {phase === 'done' && <DoneBody state={state} project={props.project} />}
        {phase === 'failed' && <FailedBody state={state} />}
      </div>
      <footer className="xd-foot">
        {phase === 'settings' && (
          <>
            <button type="button" className="btn-ghost" onClick={on.close}>
              {t.cancel}
            </button>
            <span className="xd-grow" />
            <button type="button" className="btn-accent" disabled={startDisabled} onClick={on.start}>
              <Download className="ic sm" /> {t.startExport}
            </button>
          </>
        )}
        {phase === 'running' && (
          <>
            <span className="xd-grow" />
            <button type="button" className="btn-danger" onClick={on.cancelExport}>
              {t.cancelExport}
            </button>
          </>
        )}
        {phase === 'done' && (
          <>
            <button type="button" className="btn-ghost" onClick={on.openFolder}>
              <FolderOpen className="ic sm" /> {t.openFolder}
            </button>
            <span className="xd-grow" />
            <button type="button" className="btn-accent" onClick={on.finish}>
              {t.finish}
            </button>
          </>
        )}
        {phase === 'failed' && (
          <>
            <button type="button" className="btn-ghost" onClick={on.copyError}>
              <Copy className="ic sm" /> {t.copyError}
            </button>
            <span className="xd-grow" />
            <button type="button" className="btn-ghost" onClick={on.finish}>
              {t.closeBtn}
            </button>
            <button type="button" className="btn-accent" onClick={on.retry}>
              {t.retry}
            </button>
          </>
        )}
      </footer>
      {state.h264.step !== 'idle' && <OpenH264Dialog state={state.h264} onDecline={on.declineConsent} onAccept={on.acceptConsent} />}
    </aside>
  )
}

export interface ExportDrawerProps {
  controller: ExportController
  project: Project
  base: ExportPlanBase | null
  /** 關閉抽屜（設定／完成／失敗：呼叫端關閉；進行中：縮小為徽章，匯出繼續） */
  onClose: () => void
}

/** 匯出抽屜容器：訂閱控制器、焦點進入／還原、Tab 陷阱、Esc（進行中＝縮小，不取消）。 */
export function ExportDrawer({ controller, project, base, onClose }: ExportDrawerProps): JSX.Element {
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
  const ref = useRef<HTMLElement>(null)
  const stateRef = useRef(state)
  stateRef.current = state

  const items: ExportItem[] = project.items.map((i) => ({ id: i.id, source: i.source, start: i.start, end: i.end }))
  const plan: ExportPlan | null = base ? { ...base, mode: state.settings.mode, quality: state.settings.quality } : null
  const vm = exportViewModel(project, plan, { encoders: state.encoders, openh264: state.openh264Installed })
  const sourceCount = new Set(project.items.map((i) => i.source)).size

  const closeNow = (): void => {
    if (stateRef.current.phase !== 'running') controller.finish()
    onClose()
  }

  // 開啟時記住觸發元素並把焦點移進抽屜；關閉時還原
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    ref.current?.focus()
    return () => {
      if (prev && document.contains(prev)) prev.focus()
    }
  }, [])

  // 階段切換（按鈕換掉）後把焦點拉回抽屜，避免焦點掉到 body
  useEffect(() => {
    ref.current?.focus()
  }, [state.phase])

  // 同意對話框出現時焦點進入它
  const h264Step = state.h264.step
  useEffect(() => {
    if (h264Step !== 'idle') ref.current?.querySelector<HTMLElement>('.xd-consent button:not([disabled])')?.focus()
  }, [h264Step])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing || e.keyCode === 229) return
      const st = stateRef.current
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation() // 抽屜開啟時只由這裡處理 Esc
        if (st.h264.step === 'consent' || st.h264.step === 'error') controller.declineConsent()
        else if (st.h264.step === 'downloading') return
        else closeNow() // 進行中：closeNow 只關閉（縮小），不取消
      } else if (e.key === 'Tab') {
        const root = ref.current?.querySelector<HTMLElement>('.xd-consent') ?? ref.current
        if (!root) return
        const list = Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]'))
        const i = nextTrapIndex(list.length, list.indexOf(document.activeElement as HTMLElement), e.shiftKey)
        if (i >= 0) {
          e.preventDefault()
          list[i].focus()
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller])

  const on: ExportDrawerViewProps['on'] = {
    mode: (m) => controller.setMode(m),
    quality: (q) => void controller.setQuality(q),
    encoder: (e) => controller.setEncoder(e),
    baseName: (n) => controller.setBaseName(n),
    browse: () => void controller.chooseOutDir(),
    start: () => {
      if (vm.openh264Required) void controller.setQuality('precise')
      else if (vm.canStart) void controller.start(items)
    },
    cancelExport: () => void controller.cancel(),
    close: closeNow,
    minimize: onClose,
    retry: () => void controller.retry(),
    finish: closeNow,
    openFolder: () => void controller.openFolder(),
    copyError: () => void navigator.clipboard?.writeText(stateRef.current.result?.error ?? '').catch(() => undefined),
    declineConsent: () => controller.declineConsent(),
    acceptConsent: () => void controller.acceptConsent()
  }

  return <ExportDrawerView drawerRef={ref} state={state} vm={vm} project={project} items={items} sourceCount={sourceCount} on={on} />
}
