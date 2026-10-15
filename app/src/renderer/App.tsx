import React, { useEffect, useRef, useState } from 'react'
import { LibraryScreen } from './library/LibraryScreen'
import { StudioScreen } from './studio/StudioScreen'
import { LONG_FIXTURE_PATH, longFixtureRequested, projectFixtureRequested } from './dev/fixture'
import { ProjectProvider, useProject } from './editor/ProjectProvider'
import { FocusZoneProvider } from './input/FocusZoneProvider'
import { AppShell } from './shell/AppShell'
import { RailView } from './shell/Rail'
import { shellI18n } from './i18n/zh-TW'

type View = 'library' | 'studio' | 'settings'

export default function App(): JSX.Element {
  return (
    <FocusZoneProvider>
      <ProjectProvider>
        <AppContent />
      </ProjectProvider>
    </FocusZoneProvider>
  )
}

function AppContent(): JSX.Element {
  const { project, apply } = useProject()
  const [view, setView] = useState<View>(() => (longFixtureRequested() ? 'studio' : 'library'))
  const [currentVideo, setCurrentVideo] = useState<string | null>(() =>
    longFixtureRequested() ? LONG_FIXTURE_PATH : null
  )

  // 僅開發模式：fixture 專案（截圖用），只放一次；內容動態載入，正式 bundle 不含
  const fixtureDoneRef = useRef(false)
  const projectRef = useRef(project)
  projectRef.current = project
  useEffect(() => {
    if (!import.meta.env.DEV || !projectFixtureRequested() || fixtureDoneRef.current) return
    fixtureDoneRef.current = true
    void import('./dev/projectFixture').then((m) => {
      apply({ ...projectRef.current, name: '示範專案', items: m.fixtureProjectItems() })
    })
  }, [apply])

  const handleSelectVideo = (path: string) => {
    setCurrentVideo(path)
    setView('studio')
  }

  // 工作室在尚未選定影片時回到影片庫
  const handleNavigate = (v: RailView) => {
    if (v === 'studio' && !currentVideo) setView('library')
    else setView(v)
  }

  let page: JSX.Element
  if (view === 'studio' && currentVideo) {
    page = <StudioScreen key={currentVideo} videoPath={currentVideo} onBack={() => setView('library')} />
  } else if (view === 'settings') {
    page = (
      <div className="placeholder-page">
        <h1>{shellI18n.settings.title}</h1>
        <p>{shellI18n.settings.placeholder}</p>
      </div>
    )
  } else {
    page = <LibraryScreen onSelectVideo={handleSelectVideo} onOpenSettings={() => setView('settings')} />
  }

  return (
    <AppShell active={view} projectCount={project.items.length} onNavigate={handleNavigate}>
      {page}
    </AppShell>
  )
}
