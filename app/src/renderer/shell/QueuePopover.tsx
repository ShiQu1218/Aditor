import React, { useEffect, useRef } from 'react'
import type { QueueRow as QueueRowData } from '../../shared/queueState'
import { formatEta } from '../../shared/eta'
import { fileName } from '../library/VideoCard'
import { useQueueSummary } from '../queue/QueueProvider'
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
 * 分析佇列浮層：列出分析中／排隊中（取自 main 的真實佇列）、百分比、ETA 與〔取消〕（`queue.cancel`）。
 * Esc 或點擊外部關閉。關閉時不掛載內容（不訂閱佇列、不註冊監聽）。
 */
export function QueuePopover({ open, ...rest }: QueuePopoverProps): JSX.Element | null {
  return open ? <QueuePopoverBody {...rest} /> : null
}

function QueuePopoverBody({ onClose, variant = 'rail', anchorRef }: Omit<QueuePopoverProps, 'open'>): JSX.Element {
  const summary = useQueueSummary()
  const popRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
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
  }, [onClose, anchorRef])

  return (
    <div ref={popRef} className={`pop qpop${variant === 'strip' ? ' strip' : ''}`} role="dialog" aria-label={t.title}>
      <header className="qpop-head">
        <h3>{t.title}</h3>
        <span className="dim">{t.oneAtATime}</span>
      </header>
      {summary.total === 0 ? (
        <p className="qpop-empty">{t.empty}</p>
      ) : (
        <div className="qlist">
          {summary.rows.map((row) => (
            <QueueRow key={row.path} row={row} />
          ))}
        </div>
      )}
    </div>
  )
}

function QueueRow({ row }: { row: QueueRowData }): JSX.Element {
  const analyzing = row.state === 'analyzing'
  const pct = Math.round(row.progress * 100)
  return (
    <div className="qrow">
      <div className="qname">
        <div className="qtitle" title={fileName(row.path)}>
          {fileName(row.path)}
        </div>
        <div className="dim">
          {analyzing
            ? `${t.analyzingPct.replace('{n}', String(pct))}${row.etaMs != null ? ` · ${formatEta(row.etaMs)}` : ''}`
            : t.waiting}
        </div>
      </div>
      <button
        type="button"
        className="btn sm ghost"
        onClick={() => {
          void window.api?.queue?.cancel?.(row.path)
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
