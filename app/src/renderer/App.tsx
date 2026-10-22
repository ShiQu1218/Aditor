import { tr } from '../shared/locale'
import { useCallback, useEffect, useRef, useState } from 'react'
import { LibraryScreen } from './library/LibraryScreen'
import { StudioScreen, type ProjectPlaybackRequest } from './studio/StudioScreen'
import { StudioLanding } from './studio/StudioLanding'
import { LONG_FIXTURE_PATH, longFixtureRequested, lowPerfFixtureRequested, projectFixtureRequested, settingsFixtureRequested } from './dev/fixture'
import { ProjectProvider, useProject } from './editor/ProjectProvider'
import { FocusZoneProvider } from './input/FocusZoneProvider'
import { AppShell } from './shell/AppShell'
import { RailView } from './shell/Rail'
import { SettingsScreen } from './settings/SettingsScreen'
import type { CategoryId } from './settings/rows'
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
  // Low-performance mode: toggle <html data-lowperf> immediately when the setting changes.
  useEffect(() => {
    if (lowPerfFixtureRequested()) setLowPerf(true)
    return watchLowPerfSetting(window.api)
  }, [])
  // Development only: ?fixture=settings opens the settings screen directly and attaches fake IPC after dynamic import.
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
  const [settingsDestination, setSettingsDestination] = useState<{ category?: CategoryId; request: number }>({ request: 0 })
  const [currentVideo, setCurrentVideo] = useState<string | null>(() =>
    longFixtureRequested() ? LONG_FIXTURE_PATH : null
  )
  const [playbackRequest, setPlaybackRequest] = useState<ProjectPlaybackRequest | undefined>()
  const studioLeaveGuard = useRef<(() => boolean) | null>(null)

  const registerStudioLeaveGuard = useCallback((guard: () => boolean): (() => void) => {
    studioLeaveGuard.current = guard
    return () => {
      if (studioLeaveGuard.current === guard) studioLeaveGuard.current = null
    }
  }, [])

  // Development only: load the screenshot project fixture once; its data is dynamically imported and excluded from the production bundle.
  const fixtureDoneRef = useRef(false)
  const projectRef = useRef(project)
  projectRef.current = project
  useEffect(() => {
    if (!import.meta.env.DEV || !projectFixtureRequested() || fixtureDoneRef.current) return
    fixtureDoneRef.current = true
    void import('./dev/projectFixture').then((m) => {
      apply({ ...projectRef.current, name: tr('示範專案'), items: m.fixtureProjectItems() })
    })
  }, [apply])

  const handleSelectVideo = (path: string, request?: ProjectPlaybackRequest) => {
    setPlaybackRequest(request)
    setCurrentVideo(path)
    setView('studio')
  }

  const handleNavigate = (v: RailView, settingsCategory?: CategoryId) => {
    if (view === 'studio' && v !== 'studio' && studioLeaveGuard.current && !studioLeaveGuard.current()) return
    if (v === 'settings') {
      // Remount even when already in Settings, clearing search and selecting the requested category.
      setSettingsDestination((previous) => ({ category: settingsCategory, request: previous.request + 1 }))
    }
    setView(v)
  }

  const handleOpenLive = () => {
    if (view === 'studio' && studioLeaveGuard.current && !studioLeaveGuard.current()) return
    setView('live')
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
        onVideoRemoved={(path) => setCurrentVideo((current) =>
          current?.replace(/\\/g, '/').toLowerCase() === path.replace(/\\/g, '/').toLowerCase() ? null : current)}
        onRegisterLeaveGuard={registerStudioLeaveGuard}
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
      <SettingsScreen
        key={settingsDestination.request}
        initialQuery={settingsDestination.category ? '' : settingsFx?.q}
        initialCategory={settingsDestination.category ?? settingsFx?.cat}
      />
    ) : (
      <div />
    )
  } else {
    page = <LibraryScreen onSelectVideo={handleSelectVideo} onOpenSettings={() => setView('settings')} />
  }

  return (
    <AppShell active={view === 'live' ? null : view} projectCount={project.items.length} onNavigate={handleNavigate} onOpenLive={handleOpenLive}>
      <LowPerfNotice />
      {page}
    </AppShell>
  )
}
