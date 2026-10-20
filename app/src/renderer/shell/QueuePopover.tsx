import React, { useEffect, useId, useRef } from 'react'
import { useFocusTrap } from '../a11y/useFocusTrap'
import type { QueueRow as QueueRowData } from '../../shared/queueState'
import { formatEta } from '../../shared/eta'
import { fileName } from '../library/VideoCard'
import { useQueueSummary } from '../queue/QueueProvider'
import { i18n } from '../i18n'

const t = i18n.queue

export interface QueuePopoverProps {
  open: boolean
  onClose: () => void
  /** 'rail' = fixed next to the icon rail; 'strip' = positioned by the queue-bar container (below it). */
  variant?: 'rail' | 'strip'
  /** Trigger button; clicks on it do not count as outside clicks (the caller toggles the popover). */
  anchorRef?: React.RefObject<HTMLElement>
}

/**
 * Analysis queue popover: list analyzing/queued jobs (from main's live queue), percentages, ETA, and cancel action (`queue.cancel`).
 * Close on Escape or outside click. Do not mount its contents when closed (no queue subscription or event listeners).
 */
export function QueuePopover({ open, ...rest }: QueuePopoverProps): JSX.Element | null {
  return open ? <QueuePopoverBody {...rest} /> : null
}

function QueuePopoverBody({ onClose, variant = 'rail', anchorRef }: Omit<QueuePopoverProps, 'open'>): JSX.Element {
  const summary = useQueueSummary()
  const popRef = useRef<HTMLDivElement>(null)

  const titleId = useId()
  // Escape closes the popover; trap focus and return focus to the queue button in the icon rail after closing.
  useFocusTrap(popRef, { onEscape: onClose })

  useEffect(() => {
    const onMouseDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (popRef.current?.contains(target) || anchorRef?.current?.contains(target)) {
        return
      }
      onClose()
    }
    window.addEventListener('mousedown', onMouseDown)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
    }
  }, [onClose, anchorRef])

  return (
    <div ref={popRef} className={`pop qpop${variant === 'strip' ? ' strip' : ''}`} role="dialog" aria-labelledby={titleId}>
      <header className="qpop-head">
        <h3 id={titleId}>{t.title}</h3>
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
        className="lib-btn sm ghost"
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
