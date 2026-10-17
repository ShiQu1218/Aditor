import React, { useEffect, useId, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { useFocusTrap } from '../a11y/useFocusTrap'
import type { AutoClipParams, Clip, EngineEvent } from '../../shared/types'
import { formatTime } from '../../shared/time'
import { useDebounced } from '../hooks/useDebounced'
import { i18n } from '../i18n/zh-TW'
import { RefreshCw } from '../components/icons'
import { canApply, estimateReducer, estimateView, initialEstimate } from './autoclipEstimate'

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
  // 預估數字與可套用的片段綁在同一個狀態（含算它用的參數），以序號丟棄過期回應
  const [est, dispatchEst] = useReducer(estimateReducer, initialEstimate)
  const seqRef = useRef(0)
  const boxRef = useRef<HTMLDivElement>(null)
  const debounced = useDebounced(params, 250)

  const [position, setPosition] = useState({ top: 8, left: 8 })
  // 跟隨播放列的觸發按鈕，並維持浮層在視窗範圍內。
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

  // 即時預估：去抖 250ms 後呼叫既有 engine.autoclip（引擎不可用／失敗時維持「計算中…」並停用套用）
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
    // 參數／事件變動時下一輪 effect 會發新序號的 request，舊回應因序號不符被丟棄
  }, [debounced, events, duration])

  // Esc 關閉（輸入框聚焦時也有效；捕捉階段處理後不再傳給 keymap）＋焦點陷阱＋關閉後還原焦點
  const titleId = useId()
  useFocusTrap(boxRef, { onEscape: onClose })

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

  // 只有「目前輸入的參數」已算出結果時才能套用（輸入中、去抖中、請求中或失敗都停用）
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
