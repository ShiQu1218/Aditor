import React, { useRef, useState } from 'react'
import { formatEta } from '../../shared/eta'
import { fileName } from './VideoCard'
import { ChevronDown } from '../components/icons'
import { useEtaTracker } from '../hooks/useEtaTracker'
import { QueuePopover } from '../shell/QueuePopover'
import { QueueRing } from '../shell/QueueRing'
import { useQueueSummary } from '../shell/useQueueSummary'
import { i18n } from '../i18n/zh-TW'

const t = i18n.queue

/**
 * 影片庫頂的佇列條：分析中／等待中項目存在時顯示（目前檔名、百分比、ETA、檢視佇列）；
 * 點擊開啟佇列浮層（浮層貼在條的下方）。
 */
export function QueueStrip(): JSX.Element | null {
  const summary = useQueueSummary()
  const etas = useEtaTracker(summary.active)
  const [open, setOpen] = useState(false)
  const stripRef = useRef<HTMLButtonElement>(null)

  if (summary.active.length === 0) {
    return null
  }

  const current = summary.analyzing
  const pct = Math.round((current?.progress ?? 0) * 100)
  const eta = current ? etas.get(current.path) ?? null : null
  const index = current ? summary.active.indexOf(current) + 1 : 0

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
        <QueueRing progress={current?.progress ?? 0} />
        <div className="queue-strip-text">
          <b>{t.analyzing.replace('{i}', String(index)).replace('{n}', String(summary.active.length))}</b>{' '}
          <span className="muted">{current ? fileName(current.path) : ''}</span>
        </div>
        {current && (
          <div className="bar">
            <i style={{ width: `${pct}%` }} />
          </div>
        )}
        {current && (
          <span className="muted">
            {pct}%{eta != null ? ` · ${formatEta(eta)}` : ''}
          </span>
        )}
        <span className="grow" />
        <span className="dim">{t.view}</span>
        <ChevronDown className="ic sm dim" />
      </button>
      <QueuePopover open={open} onClose={() => setOpen(false)} variant="strip" anchorRef={stripRef} />
    </div>
  )
}
