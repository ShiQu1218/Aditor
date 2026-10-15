import React, { useState } from 'react'
import { LibraryPage } from './pages/Library'
import { ViewerPage } from './pages/Viewer'
import { EditorPage } from './pages/Editor'
import { Clip } from '../shared/types'
import { Project, createProject, addItems } from './editor/project'

export default function App(): JSX.Element {
  const [view, setView] = useState<'library' | 'viewer' | 'editor'>('library')
  const [currentVideo, setCurrentVideo] = useState<string | null>(null)
  const [project, setProject] = useState<Project>(() => createProject('我的精華專案'))

  const handleSelectVideo = (path: string) => {
    setCurrentVideo(path)
    setView('viewer')
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
    setView('editor')
  }

  if (view === 'viewer' && currentVideo) {
    return (
      <ViewerPage
        videoPath={currentVideo}
        onBack={() => setView('library')}
        onSendToProject={handleSendToProject}
      />
    )
  }

  if (view === 'editor') {
    return (
      <EditorPage
        initialProject={project}
        onBack={() => setView('library')}
      />
    )
  }

  return (
    <div style={{ backgroundColor: '#18191f', minHeight: '100vh', color: '#fff', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', padding: '8px 24px', background: '#121316', borderBottom: '1px solid #2a2b30' }}>
        <button
          onClick={() => setView('editor')}
          style={{
            background: '#228be6',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            padding: '6px 14px',
            fontSize: 13,
            fontWeight: 'bold',
            cursor: 'pointer'
          }}
        >
          進入剪輯專案 ({project.items.length} 個片段) →
        </button>
      </div>
      <LibraryPage onSelectVideo={handleSelectVideo} />
    </div>
  )
}
