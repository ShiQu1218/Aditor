import React, { useRef, useState } from 'react'
import { Rail, RailView } from './Rail'
import { ToastProvider } from './ToastHost'
import { OverlayProvider } from './OverlayHost'
import { QueuePopover } from './QueuePopover'
import { useQueueSummary } from './useQueueSummary'

interface AppShellProps {
  active: RailView | null
  projectCount: number
  onNavigate: (v: RailView) => void
  children: React.ReactNode
}

export function AppShell({ active, projectCount, onNavigate, children }: AppShellProps): JSX.Element {
  const [queueOpen, setQueueOpen] = useState(false)
  const queueButtonRef = useRef<HTMLButtonElement>(null)
  const summary = useQueueSummary()

  return (
    <ToastProvider>
      <OverlayProvider queueOpen={queueOpen}>
        <div className="app">
          <Rail
            active={active}
            projectCount={projectCount}
            onNavigate={onNavigate}
            onQueue={() => setQueueOpen((v) => !v)}
            queueProgress={summary.progress}
            queueButtonRef={queueButtonRef}
          />
          <main className="app-main">{children}</main>
          <QueuePopover open={queueOpen} onClose={() => setQueueOpen(false)} anchorRef={queueButtonRef} />
        </div>
      </OverlayProvider>
    </ToastProvider>
  )
}
