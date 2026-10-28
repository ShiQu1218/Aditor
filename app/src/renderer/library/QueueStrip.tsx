import { useRef, useState } from 'react'
import { formatEta } from '../../shared/eta'
import { fileName } from './VideoCard'
import { ChevronDown } from '../components/icons'
import { QueuePopover } from '../shell/QueuePopover'
import { QueueRing } from '../shell/QueueRing'
import { useQueueSummary } from '../queue/QueueProvider'
import { i18n } from '../i18n'

const t = i18n.queue

/**
 * Queue strip at the top of the library, shown only when main's real queue has processing/queued items
 * (imported videos that have not been queued do not count). Shows the current filename, percentage, and ETA; click to open the queue popover below the strip.
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
  const label = summary.waitingForGame ? t.waitingForGame : current
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
