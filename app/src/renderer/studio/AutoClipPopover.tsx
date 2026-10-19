import React, { useEffect, useId, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { useFocusTrap } from '../a11y/useFocusTrap'
import type { AutoClipParams, Clip, EngineEvent } from '../../shared/types'
import { formatTime } from '../../shared/time'
import { useDebounced } from '../hooks/useDebounced'
import { i18n } from '../i18n'
import { RefreshCw } from '../components/icons'
import { canApply, estimateReducer, estimateView, initialEstimate } from './autoclipEstimate'

export interface AutoClipPopoverProps {
  /** Default parameters from settings (used for Reset to Defaults and initial values). */
  defaults: AutoClipParams
  events: EngineEvent[]
  duration: number
  onClose: () => void
  /** Apply clips generated with the new parameters (the caller replaces only suggested clips, spec §3.2.4). */
  onApply: (clips: Clip[]) => void
}

interface FieldSpec {
  key: keyof AutoClipParams
  label: string
  min: number
  max: number
}

  /**
   * AI auto-clip popover (spec §3.2.4): five numeric inputs and sliders (n 1–10, gap 5–60,
   * before/after 0–30, max_len 15–300). Below, `useDebounced(params, 250)` calls
   * `engine.autoclip` to show the estimated clip count and total duration; applying replaces only existing suggestions.
   */
export function AutoClipPopover({
  defaults,
  events,
  duration,
  onClose,
  onApply
}: AutoClipPopoverProps): JSX.Element {
  const t = i18n.studio.autoClipPopover
  const [params, setParams] = useState<AutoClipParams>(defaults)
  // Keep the estimate and applicable clips in one state (including their parameters); discard stale responses by sequence number.
  const [est, dispatchEst] = useReducer(estimateReducer, initialEstimate)
  const seqRef = useRef(0)
  const boxRef = useRef<HTMLDivElement>(null)
  const debounced = useDebounced(params, 250)

  const [position, setPosition] = useState({ top: 8, left: 8 })
  // Anchor to the transport-bar trigger and keep the popover within the viewport.
  useLayoutEffect(() => {
    const place = (): void => {
      const anchor = document.querySelector('[data-autoclip="toggle"]')?.getBoundingClientRect()
      const box = boxRef.current?.getBoundingClientRect()
      if (!anchor || !box) return
      const left = Math.max(8, Math.min(anchor.left, window.innerWidth - box.width - 8))
      const top = Math.max(8, Math.min(anchor.top - box.height - 8, window.innerHeight - box.height - 8))
      setPosition({ top, left })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [])

  // Live estimate: call the existing engine.autoclip after a 250 ms debounce (keep "Calculating…" and disable Apply if the engine is unavailable or fails).
  useEffect(() => {
    const api = window.api
    if (!api?.engine?.autoclip) return
    const seq = ++seqRef.current
    dispatchEst({ type: 'request', seq, params: debounced })
    void (async () => {
      try {
        const res = await api.engine.autoclip({ events, params: debounced, duration })
        dispatchEst({ type: 'resolve', seq, clips: Array.isArray(res?.clips) ? res.clips : [] })
      } catch {
        dispatchEst({ type: 'reject', seq })
      }
    })()
  // Parameter/event changes trigger a request with a new sequence in the next effect; discard old responses with mismatched sequence numbers.
  }, [debounced, events, duration])

  // Esc closes even when an input is focused; handle during capture so keymap does not receive it, trap focus, and restore focus on close.
  const titleId = useId()
  useFocusTrap(boxRef, { onEscape: onClose })

  // Close on outside click, excluding the trigger button to avoid conflicting with its toggle.
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null
      if (target?.closest?.('[data-autoclip="toggle"]')) return
      if (!boxRef.current?.contains(target)) onClose()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [onClose])

  const fields: FieldSpec[] = [
    { key: 'n', label: t.n, min: 1, max: 10 },
    { key: 'gap', label: t.gap, min: 5, max: 60 },
    { key: 'before', label: t.before, min: 0, max: 30 },
    { key: 'after', label: t.after, min: 0, max: 30 },
    { key: 'max_len', label: t.maxLen, min: 15, max: 300 }
  ]

  const setField = (key: keyof AutoClipParams, min: number, max: number, raw: number): void => {
    const next = Math.round(Math.min(max, Math.max(min, Number.isFinite(raw) ? raw : min)))
    setParams((p) => ({ ...p, [key]: next }))
  }

  // Apply only when the current inputs have a computed result (disabled while editing, debouncing, requesting, or after failure).
  const estimate = estimateView(est, params)
  const applicable = canApply(est, params)

  return (
    <div className="autoclip-pop" style={position} ref={boxRef} role="dialog" aria-labelledby={titleId}>
      <h3 id={titleId}>{t.title}</h3>
      <p className="dim ac-desc">{t.desc}</p>

      <div className="ac-fields">
        {fields.map((f) => (
          <div key={f.key} className="ac-row">
            <span className="ac-label">{f.label}</span>
            <input
              type="number"
              className="ac-num mono"
              min={f.min}
              max={f.max}
              value={params[f.key]}
              aria-label={f.label}
              onChange={(e) => setField(f.key, f.min, f.max, Number(e.target.value))}
            />
            <input
              type="range"
              className="ac-range"
              min={f.min}
              max={f.max}
              step={1}
              value={params[f.key]}
              aria-label={`${f.label}${t.slider}`}
              onChange={(e) => setField(f.key, f.min, f.max, Number(e.target.value))}
            />
          </div>
        ))}
      </div>

      <div className="ac-foot">
        <span className="ac-est dim mono">
          {estimate
            ? t.estimate.replace('{n}', String(estimate.n)).replace('{time}', formatTime(estimate.total))
            : t.estimating}
        </span>
      </div>
      <div className="ac-actions">
        <button type="button" className="btn-ghost" onClick={() => setParams(defaults)}>
          <RefreshCw className="ic sm" />
          {t.reset}
        </button>
        <div className="hl-actions-spacer" />
        <button type="button" className="btn-ghost" onClick={onClose}>
          {t.cancel}
        </button>
        <button
          type="button"
          className="btn-accent"
          disabled={!applicable}
          onClick={() => {
            if (!applicable) return
            onApply(est.clips)
            onClose()
          }}
        >
          {applicable ? t.apply : t.estimating}
        </button>
      </div>
    </div>
  )
}
