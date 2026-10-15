import React, { useState } from 'react'
import { LibraryPage } from './pages/Library'

export default function App(): JSX.Element {
  const [currentVideo, setCurrentVideo] = useState<string | null>(null)

  return (
    <div style={{ backgroundColor: '#18191f', minHeight: '100vh', color: '#fff' }}>
      <LibraryPage
        onSelectVideo={(path) => {
          console.log('Selected video:', path)
          setCurrentVideo(path)
        }}
      />
    </div>
  )
}
