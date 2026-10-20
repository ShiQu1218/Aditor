import React, { useEffect, useRef, useState } from 'react'
import { LOCALES, LOCALE_NAMES, recordingI18n, shellI18n } from '../i18n'
import type { LanguageSetting } from '../../shared/locale'
import type { RecordingSettings } from '../../shared/recording'
import type { Settings } from '../../shared/settings'
import { tr } from '../../shared/locale'
import { useFocusTrap } from '../a11y/useFocusTrap'
import { SelectControl, type ControlIds } from '../settings/SettingControls'
import { StoragePreview } from '../settings/StoragePreview'
import { bitrateOptions, fpsOptions, heightOptions } from '../settings/recordingOptions'
import { fillTemplate } from '../settings/settingsModel'
import {
  ONBOARDING_STEPS,
  SKIP_PATCH,
  buildFinishPatch,
  defaultDraft,
  shouldShowOnboarding,
  submitOnboarding,
  type OnboardingApi,
  type OnboardingDraft,
  type OnboardingPatch
} from './onboardingModel'

const t = shellI18n.onboarding
const STEP_COUNT = ONBOARDING_STEPS.length
const STORAGE_STEP = ONBOARDING_STEPS.indexOf('storage')

/** Display order for recording mode cards; match-per-file comes first, and the default comes from DEFAULT_RECORDING_SETTINGS.mode. */
const MODE_CARDS: ReadonlyArray<{ value: RecordingSettings['mode']; title: string; desc: string }> = [
  { value: 'match', title: recordingI18n.match, desc: t.recording.modeMatchDesc },
  { value: 'session', title: recordingI18n.session, desc: t.recording.modeSessionDesc }
]

const fieldIds = (name: string): ControlIds => ({ ctl: `ob-${name}`, title: `ob-${name}-label` })

function defaultApi(): OnboardingApi {
  return (window as unknown as { api: OnboardingApi }).api
}

interface StepProps {
  draft: OnboardingDraft
  onDraft: (patch: Partial<OnboardingDraft>) => void
}

function WelcomeStep({ language, onLanguage }: { language: LanguageSetting; onLanguage: (v: LanguageSetting) => void }): JSX.Element {
  const ids = fieldIds('language')
  const options = [
    { value: 'auto', label: t.welcome.languageAuto },
    ...LOCALES.map((code) => ({ value: code, label: LOCALE_NAMES[code] }))
  ]
  return (
    <>
      <p className="ob-text">{t.welcome.body}</p>
      <div className="ob-field">
        <label id={ids.title} htmlFor={ids.ctl} className="ob-label">{t.welcome.languageLabel}</label>
        <SelectControl ids={ids} value={language} options={options} onChange={(v) => onLanguage(v as LanguageSetting)} />
      </div>
    </>
  )
}

function StorageStep({ draft, onPick }: { draft: OnboardingDraft; onPick: () => void }): JSX.Element {
  return (
    <>
      <p className="ob-text">{t.storage.body}</p>
      <div className="ob-field">
        <span className="ob-label">{t.storage.current}</span>
        <div className="ob-path-row">
          <span className="set-value mono ob-path" title={draft.storageRoot || undefined}>
            {draft.storageRoot || t.storage.loading}
          </span>
          <button type="button" className="set-btn sm" onClick={onPick}>{t.storage.choose}</button>
        </div>
      </div>
      {draft.storageRoot && <StoragePreview root={draft.storageRoot} />}
    </>
  )
}

function RecordingStep({ draft, onDraft }: StepProps): JSX.Element {
  const height = fieldIds('height')
  const fps = fieldIds('fps')
  const bitrate = fieldIds('bitrate')
  return (
    <>
      <p className="ob-text">{t.recording.body}</p>
      <fieldset className="ob-modes">
        <legend className="ob-label">{t.recording.modeLabel}</legend>
        {MODE_CARDS.map((card) => (
          <label key={card.value} className={`ob-mode${draft.mode === card.value ? ' is-selected' : ''}`}>
            <input
              type="radio"
              name="ob-mode"
              value={card.value}
              checked={draft.mode === card.value}
              onChange={() => onDraft({ mode: card.value })}
            />
            <span className="ob-mode-title">{card.title}</span>
            <span className="ob-mode-desc">{card.desc}</span>
          </label>
        ))}
      </fieldset>
      <div className="ob-grid">
        <div className="ob-field">
          <label id={height.title} htmlFor={height.ctl} className="ob-label">{t.recording.resolution}</label>
          <SelectControl ids={height} value={String(draft.height)} options={heightOptions()}
            onChange={(v) => onDraft({ height: Number(v) as RecordingSettings['height'] })} />
        </div>
        <div className="ob-field">
          <label id={fps.title} htmlFor={fps.ctl} className="ob-label">{t.recording.fps}</label>
          <SelectControl ids={fps} value={String(draft.fps)} options={fpsOptions()}
            onChange={(v) => onDraft({ fps: Number(v) as RecordingSettings['fps'] })} />
        </div>
        <div className="ob-field">
          <label id={bitrate.title} htmlFor={bitrate.ctl} className="ob-label">{t.recording.bitrate}</label>
          <SelectControl ids={bitrate} value={String(draft.bitrateKbps)} options={bitrateOptions(draft.bitrateKbps)}
            onChange={(v) => onDraft({ bitrateKbps: Number(v) })} />
        </div>
      </div>
    </>
  )
}

function DoneStep({ draft }: { draft: OnboardingDraft }): JSX.Element {
  const heightLabel = heightOptions().find((o) => o.value === String(draft.height))?.label ?? String(draft.height)
  const modeLabel = draft.mode === 'match' ? recordingI18n.match : recordingI18n.session
  return (
    <>
      <ul className="ob-summary">
        <li>{fillTemplate(t.done.summaryStorage, { dir: draft.storageRoot })}</li>
        <li>{fillTemplate(t.done.summaryMode, { mode: modeLabel })}</li>
        <li>{fillTemplate(t.done.summaryQuality, { height: heightLabel, fps: draft.fps, bitrate: draft.bitrateKbps })}</li>
      </ul>
      <h3 className="ob-subhead">{t.done.nextHeading}</h3>
      <ol className="ob-next">
        <li>{t.done.next1}</li>
        <li>{t.done.next2}</li>
        <li>{t.done.next3}</li>
      </ol>
    </>
  )
}

const STEP_TITLES: readonly string[] = [t.welcome.title, t.storage.title, t.recording.title, t.done.title]

export interface OnboardingProps {
  /** Defaults to window.api; tests can inject a value. */
  api?: OnboardingApi
  /** Current settings.language (initial value for the language selector). */
  language: LanguageSetting
  /** Test-only: step index to start from (zero-based). */
  initialStep?: number
  /** Test-only: override the initial draft values. */
  initialDraft?: Partial<OnboardingDraft>
  /** Called after completion or skipping, once settings have been written. */
  onClose?: () => void
}

/**
 * First-run onboarding, shown as a modal over the entire app.
 * On completion, write `storageRoot`, `onboardingDone`, and four recording fields at once; "Maybe later" (or Esc) only writes `onboardingDone`.
 * Changing language reloads the window, and onboarding restarts from step 1 in the new language.
 */
export function Onboarding({ api, language, initialStep = 0, initialDraft, onClose }: OnboardingProps): JSX.Element {
  const [step, setStep] = useState(initialStep)
  const [draft, setDraft] = useState<OnboardingDraft>(() => ({ ...defaultDraft(''), ...initialDraft }))
  const [lang, setLang] = useState<LanguageSetting>(language)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const mounted = useRef(false)
  const resolveApi = (): OnboardingApi => api ?? defaultApi()

  const patchDraft = (patch: Partial<OnboardingDraft>): void => setDraft((cur) => ({ ...cur, ...patch }))

  const submit = async (patch: OnboardingPatch, errorStep?: number): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    const result = await submitOnboarding(resolveApi(), patch)
    setBusy(false)
    if (result.ok) {
      onClose?.()
      return
    }
    setError(result.error)
    if (errorStep !== undefined) setStep(errorStep)
  }
  const skip = (): void => void submit(SKIP_PATCH)
  const finish = (): void => void submit(buildFinishPatch(draft), STORAGE_STEP)

  useFocusTrap(boxRef, { onEscape: skip, initialFocus: () => titleRef.current })

  // Load the suggested storage location only until the user makes a selection.
  useEffect(() => {
    let alive = true
    void Promise.resolve(resolveApi().settings.suggestStorageRoot?.())
      .then((dir) => { if (alive && dir) setDraft((cur) => (cur.storageRoot ? cur : { ...cur, storageRoot: dir })) })
      .catch(() => undefined)
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Move focus to the heading when the step changes so screen readers announce the new step.
  useEffect(() => {
    if (mounted.current) titleRef.current?.focus()
    mounted.current = true
  }, [step])

  const pickFolder = async (): Promise<void> => {
    try {
      const dir = await resolveApi().export?.selectOutDir?.()
      if (dir) {
        patchDraft({ storageRoot: dir })
        setError(null)
      }
    } catch {
      setError(tr('無法選擇資料夾，請再試一次。'))
    }
  }

  const changeLanguage = (value: LanguageSetting): void => {
    setLang(value)
    void Promise.resolve(resolveApi().settings.set({ language: value })).catch(() => undefined)
  }

  const last = step === STEP_COUNT - 1
  const storageMissing = step === STORAGE_STEP && !draft.storageRoot
  const body = [
    <WelcomeStep key="welcome" language={lang} onLanguage={changeLanguage} />,
    <StorageStep key="storage" draft={draft} onPick={() => void pickFolder()} />,
    <RecordingStep key="recording" draft={draft} onDraft={patchDraft} />,
    <DoneStep key="done" draft={draft} />
  ][step]

  return (
    <div className="ob-scrim">
      <div ref={boxRef} className="ob-dialog" role="dialog" aria-modal="true" aria-labelledby="ob-title">
        <header className="ob-head">
          <h2 id="ob-title" ref={titleRef} tabIndex={-1}>{STEP_TITLES[step]}</h2>
          <p className="ob-progress" aria-live="polite">
            {fillTemplate(t.progress, { n: step + 1, total: STEP_COUNT })}
          </p>
        </header>
        <div className="ob-body">
          {body}
          {error && <p className="ob-err" role="alert">{error}</p>}
        </div>
        <footer className="ob-foot">
          <button type="button" className="set-btn ghost" disabled={busy} onClick={skip}>{t.skip}</button>
          <span className="ob-dots" aria-hidden="true">
            {ONBOARDING_STEPS.map((name, i) => <i key={name} className={i === step ? 'is-current' : i < step ? 'is-past' : undefined} />)}
          </span>
          {step > 0 && <button type="button" className="set-btn" disabled={busy} onClick={() => setStep(step - 1)}>{t.back}</button>}
          {last ? (
            <button type="button" className="btn-accent ob-primary" disabled={busy} onClick={finish}>
              {busy ? t.saving : t.finish}
            </button>
          ) : (
            <button type="button" className="btn-accent ob-primary" disabled={busy || storageMissing} onClick={() => setStep(step + 1)}>
              {t.next}
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

/**
 * Used by AppShell: show onboarding only after settings load and while `onboardingDone === false`.
 * Hide it locally after dismissal; the settings broadcast (`settings:changed`) also updates `onboardingDone` to true.
 */
export function OnboardingHost({ settings, api }: { settings: Settings | null; api?: OnboardingApi }): JSX.Element | null {
  const [closed, setClosed] = useState(false)
  if (closed || !shouldShowOnboarding(settings)) return null
  return <Onboarding api={api} language={settings!.language} onClose={() => setClosed(true)} />
}
