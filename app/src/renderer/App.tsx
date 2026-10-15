import React, { useState } from 'react'
import { LibraryPage } from './pages/Library'
import { ViewerPage } from './pages/Viewer'
import { Clip } from '../shared/types'

export default function App(): JSX.Element {
  const [currentVideo, setCurrentVideo] = useState<string | null>(null)
  const [projectClips, setProjectClips] = useState<Clip[]>([])

  if (currentVideo) {
    return (
      <ViewerPage
        videoPath={currentVideo}
        onBack={() => setCurrentVideo(null)}
        onSendToProject={(clips) => {
          setProjectClips(clips)
          console.log('Sent clips to project:', clips)
        }}
      />
    )
  }

  return (
    <div style={{ backgroundColor: '#18191f', minHeight: '100vh', color: '#fff' }}>
      <LibraryPage onSelectVideo={(path) => setCurrentVideo(path)} />
    </div>
  )
}
