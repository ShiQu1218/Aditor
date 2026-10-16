// 元件測試用的外殼：與 App.tsx 相同的 Provider 順序（FocusZone → Project → AppShell），不含畫面切換。
import React from 'react'
import { FocusZoneProvider } from '../src/renderer/input/FocusZoneProvider'
import { ProjectProvider } from '../src/renderer/editor/ProjectProvider'
import { AppShell } from '../src/renderer/shell/AppShell'
import type { RailView } from '../src/renderer/shell/Rail'

export function Providers({
  children,
  active = 'library',
  onNavigate = () => undefined
}: {
  children: React.ReactNode
  active?: RailView
  onNavigate?: (v: RailView) => void
}): JSX.Element {
  return (
    <FocusZoneProvider>
      <ProjectProvider>
        <AppShell active={active} projectCount={0} onNavigate={onNavigate}>
          {children}
        </AppShell>
      </ProjectProvider>
    </FocusZoneProvider>
  )
}
