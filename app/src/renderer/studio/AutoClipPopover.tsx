import React, { useEffect, useRef, useState } from 'react'
import type { AutoClipParams, Clip, EngineEvent } from '../../shared/types'
import { formatTime } from '../../shared/time'
import { useDebounced } from '../hooks/useDebounced'
import { i18n } from '../i18n/zh-TW'
import { RefreshCw } from '../components/icons'

export interface AutoClipPopoverProps {
  /** 設定中的預設參數（〔重設預設值〕與初始值） */
  defaults: AutoClipParams
  events: EngineEvent[]
  duration: number
  onClose: () => void
  /** 套用：以新參數產生的片段（呼叫端只取代 suggested，spec §3.2.4） */
  onApply: (clips: Clip[]) => void
}

interface FieldSpec {
  key: keyof AutoClipParams
  label: string
  min: number
  max: number
}

/**
 * AI 自動剪輯浮層（spec §3.2.4）：五個數字框＋滑桿（n 1–10、gap 5–60、
 * before/after 0–30、max_len 15–300），下方以 `useDebounced(params, 250)` 呼叫
 * `engine.autoclip` 顯示「預計產生 N 段 · 共 mm:ss」；套用只取代現有建議框。
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
  const [estimate, setEstimate] = useState<{ n: number; total: number } | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const clipsRef = useRef<Clip[]>([])
  const debounced = useDebounced(params, 250)

  // 即時預估：去抖 250ms 後呼叫既有 engine.autoclip（引擎不可用時維持「計算中…」並停用套用）
  useEffect(() => {
    let cancelled = false
    const api = window.api
    if (!api?.engine?.autoclip) return
    void (async () => {
      try {
        const res = await api.engine.autoclip({ events, params: debounced, duration })
        if (cancelled) return
        const clips: Clip[] = Array.isArray(res?.clips) ? res.clips : []
        clipsRef.current = clips
        setEstimate({
          n: clips.length,
          total: clips.reduce((sum, c) => sum + Math.max(0, c.end - c.start), 0)
        })
      } catch {
        if (!cancelled) setEstimate(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [debounced, events, duration])

  // Esc 關閉（輸入框聚焦時也要生效 → preventDefault 讓 keymap 不重複處理）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // 點浮層外關閉（略過觸發按鈕，避免與開關切換互撞）
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

  const canApply = estimate !== null

  return (
    <div className="autoclip-pop" ref={boxRef} role="dialog" aria-label={t.title}>
      <h3>{t.title}</h3>
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
              aria-label={`${f.label}（滑桿）`}
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
          disabled={!canApply}
          onClick={() => {
            onApply(clipsRef.current)
            onClose()
          }}
        >
          {t.apply}
        </button>
      </div>
    </div>
  )
}
