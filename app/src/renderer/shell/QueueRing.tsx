import { useEffect, useRef } from 'react'
import { AnalysisQueue } from '../components/icons'
import { useQueueStore } from '../queue/QueueProvider'

/**
 * Circular queue progress: conic-gradient reads the `--p` CSS variable (0–100).
 * Update the variable directly on the DOM element (without React state), so the icon rail/AppShell do not rerender for progress events.
 */
export function QueueRing(): JSX.Element {
  const store = useQueueStore()
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const apply = (): void => {
      const summary = store.getSummary()
      const pct = Math.round(Math.min(1, Math.max(0, summary.progress)) * 100)
      if (ref.current) ref.current.dataset.active = String(summary.total > 0)
      ref.current?.style.setProperty('--p', String(pct))
    }
    apply()
    return store.subscribe(apply)
  }, [store])

  return (
    <span ref={ref} className="queue-indicator" aria-hidden="true">
      <AnalysisQueue className="ic lg" />
      <span className="ring queue-progress" />
    </span>
  )
}
