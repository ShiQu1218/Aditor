import React, { useEffect, useRef, useState } from 'react'
import { LibraryScreen } from './library/LibraryScreen'
import { StudioScreen } from './studio/StudioScreen'
import { LONG_FIXTURE_PATH, longFixtureRequested, projectFixtureRequested, settingsFixtureRequested } from './dev/fixture'
import { ProjectProvider, useProject } from './editor/ProjectProvider'
import { FocusZoneProvider } from './input/FocusZoneProvider'
import { AppShell } from './shell/AppShell'
import { RailView } from './shell/Rail'
import { SettingsScreen } from './settings/SettingsScreen'

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
  // 僅開發模式：?fixture=settings 直接開設定畫面，假 IPC 於動態載入後才掛上
  const settingsFx = settingsFixtureRequested()
  const [fxReady, setFxReady] = useState(!settingsFx)
  useEffect(() => {
    if (!import.meta.env.DEV || !settingsFx) return
    void import('./dev/settingsFixture').then((m) => {
      m.installSettingsFixtureApi(settingsFx.fail)
      setFxReady(true)
    })
  }, [settingsFx])
  const [view, setView] = useState<View>(() => (settingsFx ? 'settings' : longFixtureRequested() ? 'studio' : 'library'))
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
    page = fxReady ? (
      <SettingsScreen initialQuery={settingsFx?.q} initialCategory={settingsFx?.cat} />
    ) : (
      <div />
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
