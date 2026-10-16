import React, { useRef, useState } from 'react'
import { Rail, RailView } from './Rail'
import { ToastProvider } from './ToastHost'
import { OverlayProvider, useOverlay } from './OverlayHost'
import { QueuePopover } from './QueuePopover'
import { QueueProvider } from '../queue/QueueProvider'

interface AppShellProps {
  active: RailView | null
  projectCount: number
  onNavigate: (v: RailView) => void
  children: React.ReactNode
}

export function AppShell({ active, projectCount, onNavigate, children }: AppShellProps): JSX.Element {
  const [queueOpen, setQueueOpen] = useState(false)
  const queueButtonRef = useRef<HTMLButtonElement>(null)

  return (
    <QueueProvider>
      <ToastProvider>
        <OverlayProvider queueOpen={queueOpen}>
          <ShellFrame
            active={active}
            projectCount={projectCount}
            onNavigate={onNavigate}
            queueOpen={queueOpen}
            onToggleQueue={() => setQueueOpen((v) => !v)}
            onCloseQueue={() => setQueueOpen(false)}
            queueButtonRef={queueButtonRef}
          >
            {children}
          </ShellFrame>
        </OverlayProvider>
      </ToastProvider>
    </QueueProvider>
  )
}

/** 殼層版面（在 OverlayProvider 內，圖示欄的鍵盤按鈕才能開啟快捷鍵說明）。 */
function ShellFrame({
  active,
  projectCount,
  onNavigate,
  queueOpen,
  onToggleQueue,
  onCloseQueue,
  queueButtonRef,
  children
}: AppShellProps & {
  queueOpen: boolean
  onToggleQueue: () => void
  onCloseQueue: () => void
  queueButtonRef: React.RefObject<HTMLButtonElement>
}): JSX.Element {
  const overlay = useOverlay()
  return (
    <div className="app">
      <Rail
        active={active}
        projectCount={projectCount}
        onNavigate={onNavigate}
        onQueue={onToggleQueue}
        queueOpen={queueOpen}
        onShortcuts={overlay.openShortcuts}
        queueButtonRef={queueButtonRef}
      />
      <main className="app-main">{children}</main>
      <QueuePopover open={queueOpen} onClose={onCloseQueue} anchorRef={queueButtonRef} />
    </div>
  )
}
