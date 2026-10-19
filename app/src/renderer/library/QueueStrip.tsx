import React, { useRef, useState } from 'react'
import { formatEta } from '../../shared/eta'
import { fileName } from './VideoCard'
import { ChevronDown } from '../components/icons'
import { QueuePopover } from '../shell/QueuePopover'
import { QueueRing } from '../shell/QueueRing'
import { useQueueSummary } from '../queue/QueueProvider'
import { i18n } from '../i18n'

const t = i18n.queue

/**
 * 影片庫頂的佇列條：只在 main 的真實佇列有「分析中／排隊中」項目時顯示
 * （匯入但尚未排隊的影片不算）。顯示目前檔名、百分比、ETA；點擊開啟佇列浮層（貼在條的下方）。
 */
export function QueueStrip(): JSX.Element | null {
  const summary = useQueueSummary()
  const [open, setOpen] = useState(false)
  const stripRef = useRef<HTMLButtonElement>(null)

  if (summary.total === 0) {
    return null
  }

  const current = summary.analyzing
  const pct = Math.round((current?.progress ?? 0) * 100)
  const label = current
    ? t.analyzing.replace('{i}', '1').replace('{n}', String(summary.total))
    : t.queuedOnly.replace('{n}', String(summary.total))

  return (
    <div className="queue-strip-wrap">
      <button
        type="button"
        className="queue-strip"
        ref={stripRef}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <QueueRing />
        <div className="queue-strip-text">
          <b>{label}</b> {current && <span className="muted">{fileName(current.path)}</span>}
        </div>
        {current && (
          <div className="bar">
            <i style={{ width: `${pct}%` }} />
          </div>
        )}
        {current && (
          <span className="muted">
            {pct}%{current.etaMs != null ? ` · ${formatEta(current.etaMs)}` : ''}
          </span>
        )}
        <span className="lib-grow" />
        <span className="dim">{t.view}</span>
        <ChevronDown className="ic sm dim" />
      </button>
      <QueuePopover open={open} onClose={() => setOpen(false)} variant="strip" anchorRef={stripRef} />
    </div>
  )
}
