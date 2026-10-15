import React, { useEffect, useRef } from 'react'
import type { LibraryEntry } from '../../main/library'
import { formatEta } from '../../shared/eta'
import { fileName } from '../library/VideoCard'
import { useEtaTracker } from '../hooks/useEtaTracker'
import { useQueueSummary } from './useQueueSummary'
import { i18n } from '../i18n/zh-TW'

const t = i18n.queue

export interface QueuePopoverProps {
  open: boolean
  onClose: () => void
  /** 'rail'＝固定於圖示欄旁；'strip'＝由佇列條容器定位（貼在下方） */
  variant?: 'rail' | 'strip'
  /** 觸發按鈕；點擊它不算「點擊外部」（開關交給呼叫端切換） */
  anchorRef?: React.RefObject<HTMLElement>
}

/**
 * 分析佇列浮層：列出分析中／等待、百分比、ETA 與〔取消〕（`queue.cancel`）。
 * Esc 或點擊外部關閉；資料與圖示欄環形進度共用 `useQueueSummary`（訂閱 library:updated）。
 */
export function QueuePopover({ open, onClose, variant = 'rail', anchorRef }: QueuePopoverProps): JSX.Element | null {
  const summary = useQueueSummary()
  const etas = useEtaTracker(summary.active)
  const popRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    const onMouseDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (popRef.current?.contains(target) || anchorRef?.current?.contains(target)) {
        return
      }
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('mousedown', onMouseDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('mousedown', onMouseDown)
    }
  }, [open, onClose, anchorRef])

  if (!open) {
    return null
  }

  return (
    <div ref={popRef} className={`pop qpop${variant === 'strip' ? ' strip' : ''}`} role="dialog" aria-label={t.title}>
      <header className="qpop-head">
        <h3>{t.title}</h3>
        <span className="dim">{t.oneAtATime}</span>
      </header>
      {summary.active.length === 0 ? (
        <p className="qpop-empty">{t.empty}</p>
      ) : (
        <div className="qlist">
          {summary.active.map((entry) => (
            <QueueRow key={entry.path} entry={entry} eta={etas.get(entry.path) ?? null} />
          ))}
        </div>
      )}
    </div>
  )
}

function QueueRow({ entry, eta }: { entry: LibraryEntry; eta: number | null }): JSX.Element {
  const analyzing = entry.status === 'analyzing'
  const pct = Math.round((entry.progress ?? 0) * 100)
  return (
    <div className="qrow">
      <div className="qname">
        <div className="qtitle" title={fileName(entry.path)}>
          {fileName(entry.path)}
        </div>
        <div className="dim">
          {analyzing
            ? `${t.analyzingPct.replace('{n}', String(pct))}${eta != null ? ` · ${formatEta(eta)}` : ''}`
            : t.waiting}
        </div>
      </div>
      <button
        type="button"
        className="btn sm ghost"
        onClick={() => {
          void window.api?.queue?.cancel?.(entry.path)
        }}
      >
        {t.cancel}
      </button>
      {analyzing && (
        <div className="bar">
          <i style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  )
}
