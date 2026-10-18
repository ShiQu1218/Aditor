import React, { useEffect, useRef, useState } from 'react'
import { LibraryScreen } from './library/LibraryScreen'
import { StudioScreen, type ProjectPlaybackRequest } from './studio/StudioScreen'
import { StudioLanding } from './studio/StudioLanding'
import { LONG_FIXTURE_PATH, longFixtureRequested, lowPerfFixtureRequested, projectFixtureRequested, settingsFixtureRequested } from './dev/fixture'
import { ProjectProvider, useProject } from './editor/ProjectProvider'
import { FocusZoneProvider } from './input/FocusZoneProvider'
import { AppShell } from './shell/AppShell'
import { RailView } from './shell/Rail'
import { SettingsScreen } from './settings/SettingsScreen'
import { LiveScreen } from './live/LiveScreen'
import { setLowPerf, watchLowPerfSetting } from './perf/lowPerf'
import { LowPerfNotice } from './perf/LowPerfNotice'

type View = 'library' | 'studio' | 'settings' | 'live'

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
  // 低效能模式：<html data-lowperf> 隨設定即時切換
  useEffect(() => {
    if (lowPerfFixtureRequested()) setLowPerf(true)
    return watchLowPerfSetting(window.api)
  }, [])
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
  const [playbackRequest, setPlaybackRequest] = useState<ProjectPlaybackRequest | undefined>()

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

  const handleSelectVideo = (path: string, request?: ProjectPlaybackRequest) => {
    setPlaybackRequest(request)
    setCurrentVideo(path)
    setView('studio')
  }

  const handleNavigate = (v: RailView) => {
    setView(v)
  }

  let page: JSX.Element
  if (view === 'studio' && currentVideo) {
    page = (
      <StudioScreen
        key={currentVideo}
        videoPath={currentVideo}
        onOpenVideo={handleSelectVideo}
        playbackRequest={playbackRequest}
        onPlaybackRequestConsumed={() => setPlaybackRequest(undefined)}
        onBack={() => { setPlaybackRequest(undefined); setView('library') }}
      />
    )
  } else if (view === 'studio') {
    page = <StudioLanding onOpenVideo={handleSelectVideo} onBack={() => setView('library')} />
  } else if (view === 'live') {
    page = (
      <LiveScreen
        onBack={() => setView(currentVideo ? 'studio' : 'library')}
        onOpenVideo={(path) => handleSelectVideo(path)}
        onOpenLibrary={() => setView('library')}
      />
    )
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
    <AppShell active={view === 'live' ? null : view} projectCount={project.items.length} onNavigate={handleNavigate} onOpenLive={() => setView('live')}>
      <LowPerfNotice />
      {page}
    </AppShell>
  )
}
