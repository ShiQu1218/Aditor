import React from 'react'
import { Rail, RailView } from './Rail'
import { ToastProvider } from './ToastHost'
import { OverlayProvider } from './OverlayHost'

interface AppShellProps {
  active: RailView | null
  projectCount: number
  onNavigate: (v: RailView) => void
  children: React.ReactNode
}

export function AppShell({ active, projectCount, onNavigate, children }: AppShellProps): JSX.Element {
  return (
    <ToastProvider>
      <OverlayProvider>
        <div className="app">
          <Rail active={active} projectCount={projectCount} onNavigate={onNavigate} />
          <main className="app-main">{children}</main>
        </div>
      </OverlayProvider>
    </ToastProvider>
  )
}
