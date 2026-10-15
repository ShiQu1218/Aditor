import React, { useState, useEffect, useRef } from 'react'
import { LibraryEntry } from '../../main/library'
import { VideoCard } from '../components/VideoCard'
import { i18n } from '../i18n/zh-TW'
import { EventType } from '../../shared/types'

interface LibraryPageProps {
  onSelectVideo: (path: string) => void
}

export function LibraryPage({ onSelectVideo }: LibraryPageProps): JSX.Element {
  const [entries, setEntries] = useState<LibraryEntry[]>([])
  const [query, setQuery] = useState('')
  const [favoriteOnly, setFavoriteOnly] = useState(false)
  const [eventFilter, setEventFilter] = useState<'all' | 'knock' | 'assist'>('all')
  const [isDragging, setIsDragging] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const loadEntries = async () => {
    // @ts-ignore
    if (window.api?.library?.getEntries) {
      // @ts-ignore
      const data = await window.api.library.getEntries()
      setEntries(data || [])
    }
  }

  useEffect(() => {
    loadEntries()

    // @ts-ignore
    const unsubscribe = window.api?.library?.onUpdated?.(() => {
      loadEntries()
    })

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        searchInputRef.current?.focus()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        setFavoriteOnly((prev) => !prev)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      unsubscribe?.()
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  const handleImportFiles = async () => {
    // @ts-ignore
    await window.api?.library?.selectFiles?.()
  }

  const handleImportFolder = async () => {
    // @ts-ignore
    await window.api?.library?.selectFolder?.()
  }

  const handleToggleFavorite = async (path: string, e: React.MouseEvent) => {
    e.stopPropagation()
    // @ts-ignore
    await window.api?.library?.toggleFavorite?.(path)
  }

  const handleRemove = async (path: string, e: React.MouseEvent) => {
    e.stopPropagation()
    // @ts-ignore
    await window.api?.library?.remove?.(path)
  }

  const handleRetry = async (path: string, e: React.MouseEvent) => {
    e.stopPropagation()
    // @ts-ignore
    await window.api?.queue?.enqueue?.(path)
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const files = Array.from(e.dataTransfer.files).map((f) => f.path)
    if (files.length > 0) {
      // @ts-ignore
      await window.api?.library?.add?.(files)
    }
  }

  // Filter entries
  const filtered = entries.filter((entry) => {
    if (favoriteOnly && !entry.favorite) {
      return false
    }
    if (query) {
      const filename = entry.path.split(/[/\\]/).pop()?.toLowerCase() || ''
      if (!filename.includes(query.toLowerCase())) {
        return false
      }
    }
    if (eventFilter === 'knock' && (entry.counts?.knock ?? 0) <= 0) {
      return false
    }
    if (eventFilter === 'assist' && (entry.counts?.assist ?? 0) <= 0) {
      return false
    }
    return true
  })

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        setIsDragging(true)
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
      style={{
        padding: 24,
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
        minHeight: '100vh',
        boxSizing: 'border-box',
        backgroundColor: '#18191f',
        position: 'relative'
      }}
    >
      {/* Drag overlay */}
      {isDragging && (
        <div
          style={{
            position: 'absolute',
            inset: 12,
            border: '2px dashed #e13b30',
            borderRadius: 12,
            backgroundColor: 'rgba(225, 59, 48, 0.1)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
            pointerEvents: 'none'
          }}
        >
          <div style={{ fontSize: 20, fontWeight: 600, color: '#e13b30' }}>
            放開滑鼠以匯入影片檔案
          </div>
        </div>
      )}

      {/* Header controls */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 22, color: '#fff' }}>{i18n.library.title}</h2>
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={handleImportFiles}
            style={{
              padding: '8px 16px',
              backgroundColor: '#e13b30',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: 14
            }}
          >
            + {i18n.library.importFiles}
          </button>
          <button
            onClick={handleImportFolder}
            style={{
              padding: '8px 16px',
              backgroundColor: '#262833',
              color: '#fff',
              border: '1px solid #363945',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 14
            }}
          >
            {i18n.library.importFolder}
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          flexWrap: 'wrap',
          backgroundColor: '#20222b',
          padding: 12,
          borderRadius: 8
        }}
      >
        <input
          ref={searchInputRef}
          type="text"
          placeholder={i18n.library.searchPlaceholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{
            flex: 1,
            minWidth: 200,
            padding: '8px 12px',
            backgroundColor: '#18191f',
            border: '1px solid #363945',
            borderRadius: 6,
            color: '#fff',
            fontSize: 14
          }}
        />

        <button
          onClick={() => setFavoriteOnly(!favoriteOnly)}
          style={{
            padding: '8px 14px',
            backgroundColor: favoriteOnly ? '#ffcc00' : '#262833',
            color: favoriteOnly ? '#000' : '#fff',
            border: '1px solid #363945',
            borderRadius: 6,
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: 600
          }}
        >
          ★ {i18n.library.favoriteFilter}
        </button>

        <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #363945' }}>
          {(['all', 'knock', 'assist'] as const).map((filterKey) => (
            <button
              key={filterKey}
              onClick={() => setEventFilter(filterKey)}
              style={{
                padding: '8px 14px',
                backgroundColor: eventFilter === filterKey ? '#e13b30' : '#262833',
                color: '#fff',
                border: 'none',
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: eventFilter === filterKey ? 600 : 400
              }}
            >
              {filterKey === 'all'
                ? i18n.library.filterAll
                : filterKey === 'knock'
                ? i18n.library.filterKnock
                : i18n.library.filterAssist}
            </button>
          ))}
        </div>
      </div>

      {/* Video Grid */}
      {filtered.length === 0 ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#64748b',
            padding: 40,
            gap: 12
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 600, color: '#94a3b8' }}>
            {entries.length === 0 ? i18n.library.emptyTitle : '無符合篩選條件的影片'}
          </div>
          <div style={{ fontSize: 14 }}>
            {entries.length === 0 ? i18n.library.emptyDesc : '請嘗試調整搜尋關鍵字或事件篩選。'}
          </div>
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
            gap: 16
          }}
        >
          {filtered.map((entry) => (
            <VideoCard
              key={entry.path}
              entry={entry}
              onSelect={() => onSelectVideo(entry.path)}
              onToggleFavorite={handleToggleFavorite}
              onRemove={handleRemove}
              onRetry={handleRetry}
            />
          ))}
        </div>
      )}
    </div>
  )
}
