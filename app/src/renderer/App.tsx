import React, { useState } from 'react'
import { LibraryScreen } from './library/LibraryScreen'
import { StudioScreen } from './studio/StudioScreen'
import { EditorPage } from './pages/Editor'
import { LONG_FIXTURE_PATH, longFixtureRequested } from './dev/fixture'
import { ProjectProvider, useProject } from './editor/ProjectProvider'
import { FocusZoneProvider } from './input/FocusZoneProvider'
import { AppShell } from './shell/AppShell'
import { RailView } from './shell/Rail'
import { shellI18n } from './i18n/zh-TW'

type View = 'library' | 'studio' | 'settings' | 'legacy-editor'

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
  const { project } = useProject()
  const [view, setView] = useState<View>(() => (longFixtureRequested() ? 'studio' : 'library'))
  const [currentVideo, setCurrentVideo] = useState<string | null>(() =>
    longFixtureRequested() ? LONG_FIXTURE_PATH : null
  )

  const handleSelectVideo = (path: string) => {
    setCurrentVideo(path)
    setView('studio')
  }

  // 工作室在尚未選定影片時回到影片庫（暫時行為，Task 13 之後改版）
  const handleNavigate = (v: RailView) => {
    if (v === 'studio' && !currentVideo) setView('library')
    else setView(v)
  }

  const railActive: RailView | null = view === 'legacy-editor' ? 'studio' : view

  let page: JSX.Element
  if (view === 'studio' && currentVideo) {
    page = (
      <StudioScreen
        key={currentVideo}
        videoPath={currentVideo}
        onBack={() => setView('library')}
        onOpenLegacyEditor={() => setView('legacy-editor')}
      />
    )
  } else if (view === 'legacy-editor') {
    page = <EditorPage initialProject={project} onBack={() => setView('library')} />
  } else if (view === 'settings') {
    page = (
      <div className="placeholder-page">
        <h1>{shellI18n.settings.title}</h1>
        <p>{shellI18n.settings.placeholder}</p>
      </div>
    )
  } else {
    page = (
      <>
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 24px' }}>
          <button
            onClick={() => setView('legacy-editor')}
            style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 0, borderRadius: 'var(--r-sm)', padding: '6px 14px', fontWeight: 700 }}
          >
            {shellI18n.legacyEditor} ({project.items.length} 個片段) →
          </button>
        </div>
        <LibraryScreen onSelectVideo={handleSelectVideo} onOpenSettings={() => setView('settings')} />
      </>
    )
  }

  return (
    <AppShell active={railActive} projectCount={project.items.length} onNavigate={handleNavigate}>
      {page}
    </AppShell>
  )
}
