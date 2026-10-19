import React, { useRef, useState } from 'react'
import { Rail, RailView } from './Rail'
import { ToastProvider } from './ToastHost'
import { OverlayProvider, useOverlay } from './OverlayHost'
import { QueuePopover } from './QueuePopover'
import { QueueProvider } from '../queue/QueueProvider'
import { useProject } from '../editor/ProjectProvider'
import { useToast } from './ToastHost'
import { i18n } from '../i18n'
import { RecordingPanel } from './RecordingPanel'
import { useRecordingStatus } from './useRecordingStatus'
import { useAppSettings } from './useAppSettings'
import { OnboardingHost } from '../onboarding/Onboarding'

/** 啟動還原遇到損毀／過新版本專案時顯示一次 Toast（I12）。 */
function RestoreNotice(): null {
  const { restoreNotice } = useProject()
  const toast = useToast()
  const shown = useRef(false)
  React.useEffect(() => {
    if (!restoreNotice || shown.current) return
    shown.current = true
    const t = i18n.studio.toast
    toast({ message: restoreNotice === 'corrupt' ? t.projectRestoreCorrupt : t.projectRestoreUnsupported })
  }, [restoreNotice, toast])
  return null
}

interface AppShellProps {
  active: RailView | null
  projectCount: number
  onNavigate: (v: RailView) => void
  /** 錄影面板「觀看當局」：切到錄影中觀看畫面 */
  onOpenLive?: () => void
  children: React.ReactNode
}

export function AppShell({ active, projectCount, onNavigate, onOpenLive, children }: AppShellProps): JSX.Element {
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
            onOpenLive={onOpenLive}
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
  onOpenLive,
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
  const recording = useRecordingStatus()
  // 首次啟動引導：設定載入完成且 onboardingDone 為 false 時疊在整個 app 上
  const settings = useAppSettings()
  return (
    <div className="app">
      <RestoreNotice />
      <Rail
        active={active}
        projectCount={projectCount}
        onNavigate={onNavigate}
        onQueue={onToggleQueue}
        queueOpen={queueOpen}
        onShortcuts={overlay.openShortcuts}
        queueButtonRef={queueButtonRef}
        recordingPhase={recording.status.phase}
        onRecording={() => {
          onCloseQueue()
          const watchLive = onOpenLive ? (): void => { overlay.close(); onOpenLive() } : undefined
          overlay.open(<RecordingPanel onClose={overlay.close} onWatchLive={watchLive} />)
        }}
      />
      <main className="app-main">{children}</main>
      <QueuePopover open={queueOpen} onClose={onCloseQueue} anchorRef={queueButtonRef} />
      <OnboardingHost settings={settings} />
    </div>
  )
}
