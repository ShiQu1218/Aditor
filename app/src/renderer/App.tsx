import React, { useState } from 'react'
import { LibraryPage } from './pages/Library'
import { ViewerPage } from './pages/Viewer'
import { EditorPage } from './pages/Editor'
import { Clip } from '../shared/types'
import { Project, createProject, addItems } from './editor/project'
import { AppShell } from './shell/AppShell'
import { RailView } from './shell/Rail'
import { shellI18n } from './i18n/zh-TW'

type View = 'library' | 'studio' | 'settings' | 'legacy-editor'

export default function App(): JSX.Element {
  const [view, setView] = useState<View>('library')
  const [currentVideo, setCurrentVideo] = useState<string | null>(null)
  const [project, setProject] = useState<Project>(() => createProject('我的精華專案'))

  const handleSelectVideo = (path: string) => {
    setCurrentVideo(path)
    setView('studio')
  }

  const handleSendToProject = (clips: Clip[]) => {
    if (!currentVideo) return
    const newItems = clips.map((c) => ({
      id: `item_${Date.now()}_${c.id}`,
      source: currentVideo,
      start: c.start,
      end: c.end
    }))
    setProject((prev) => addItems(prev, newItems))
    setView('legacy-editor')
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
      <ViewerPage
        videoPath={currentVideo}
        onBack={() => setView('library')}
        onSendToProject={handleSendToProject}
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
        <LibraryPage onSelectVideo={handleSelectVideo} />
      </>
    )
  }

  return (
    <AppShell active={railActive} projectCount={project.items.length} onNavigate={handleNavigate}>
      {page}
    </AppShell>
  )
}
