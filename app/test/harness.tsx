// Component-test shell: uses the same Provider order as App.tsx (FocusZone → Project → AppShell), without screen switching.
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
