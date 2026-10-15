import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LibraryEntry } from '../../main/library'
import { DropOverlay } from './DropOverlay'
import { EmptyState } from './EmptyState'
import { LibraryToolbar } from './LibraryToolbar'
import { QueueStrip } from './QueueStrip'
import { VideoCard, fileName } from './VideoCard'
import { VirtualGrid } from './VirtualGrid'
import { groupByDate } from '../lib/groupByDate'
import { filterEntries, type LibraryKind } from '../lib/libraryFilter'
import { useKeymap } from '../hooks/useShortcuts'
import { useToast } from '../shell/ToastHost'
import { useQueueStore } from '../queue/QueueProvider'
import { i18n } from '../i18n/zh-TW'
import { library500Requested, libraryFixtureOnce } from '../dev/libraryFixture'

const t = i18n.library

interface LibraryScreenProps {
  onSelectVideo: (path: string) => void
  onOpenSettings: () => void
}

export function LibraryScreen({ onSelectVideo, onOpenSettings }: LibraryScreenProps): JSX.Element {
  const toast = useToast()
  const queueStore = useQueueStore()
  const [entries, setEntries] = useState<LibraryEntry[]>([])
  const [query, setQuery] = useState('')
  const [favoriteOnly, setFavoriteOnly] = useState(false)
  const [kind, setKind] = useState<LibraryKind>('all')
  const [dragging, setDragging] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  // main 已把 library:updated 節流為最多每 500 ms 一次（含尾端），這裡不再另行節流
  const load = useCallback(async () => {
    if (library500Requested()) {
      setEntries(libraryFixtureOnce())
      return
    }
    const data = await window.api?.library?.getEntries?.()
    if (Array.isArray(data)) setEntries(data)
  }, [])

  useEffect(() => {
    void load()
    const unsubscribe = window.api?.library?.onUpdated?.(() => {
      void load()
    })
    return () => unsubscribe?.()
  }, [load])

  useKeymap(
    {
      focusSearch: () => searchRef.current?.focus(),
      toggleFavoriteFilter: () => setFavoriteOnly((v) => !v),
      closeOverlay: () => setQuery('')
    },
    { screen: 'library' }
  )

  const filtered = useMemo(() => filterEntries(entries, { query, favoriteOnly, kind }), [entries, query, favoriteOnly, kind])
  const groups = useMemo(() => groupByDate(filtered), [filtered])
  const counts = useMemo(
    () => ({
      all: entries.length,
      knock: filterEntries(entries, { query: '', favoriteOnly: false, kind: 'knock' }).length,
      assist: filterEntries(entries, { query: '', favoriteOnly: false, kind: 'assist' }).length,
      hl: filterEntries(entries, { query: '', favoriteOnly: false, kind: 'hl' }).length
    }),
    [entries]
  )

  const handleImportFiles = useCallback(() => {
    void window.api?.library?.selectFiles?.()
  }, [])

  const handleImportFolder = useCallback(() => {
    void window.api?.library?.selectFolder?.()
  }, [])

  const handleOpen = useCallback(
    (entry: LibraryEntry) => {
      if (entry.status === 'done') {
        onSelectVideo(entry.path)
      } else if (entry.status !== 'error') {
        toast({ message: queueStore.stateOf(entry.path) === 'idle' ? t.card.notAnalyzedToast : t.card.openBlocked })
      }
    },
    [onSelectVideo, toast, queueStore]
  )

  const handleToggleFavorite = useCallback((path: string) => {
    void window.api?.library?.toggleFavorite?.(path)
  }, [])

  const handleRemove = useCallback((path: string) => {
    const confirmed = window.confirm(t.card.removeConfirm.replace('{name}', fileName(path)))
    if (!confirmed) return
    void window.api?.library?.remove?.(path)
  }, [])

  const handleRetry = useCallback((path: string) => {
    void window.api?.queue?.enqueue?.(path)
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)
      const files = Array.from(e.dataTransfer.files)
        .map((f) => (f as File & { path?: string }).path)
        .filter((p): p is string => Boolean(p))
      if (files.length > 0) {
        void window.api?.library?.add?.(files)
      }
    },
    []
  )

  return (
    <div
      className="lib-screen"
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        // 只在離開整個畫面時收起覆蓋層
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
      }}
      onDrop={handleDrop}
    >
      <header className="lib-topbar">
        <h1>{t.title}</h1>
        <div className="grow" />
        <button type="button" className="btn" onClick={handleImportFolder}>
          {t.importFolder}
        </button>
        <button type="button" className="btn primary" onClick={handleImportFiles}>
          {t.importFiles}
        </button>
      </header>

      {entries.length === 0 ? (
        <EmptyState onImportFiles={handleImportFiles} onImportFolder={handleImportFolder} onOpenSettings={onOpenSettings} />
      ) : (
        <>
          <LibraryToolbar
            query={query}
            onQueryChange={setQuery}
            favoriteOnly={favoriteOnly}
            onToggleFavorite={() => setFavoriteOnly((v) => !v)}
            kind={kind}
            onKindChange={setKind}
            counts={counts}
            searchRef={searchRef}
          />
          <QueueStrip />
          {filtered.length === 0 ? (
            <div className="lib-noresults">
              <h2>{t.noResults.title}</h2>
              <p className="muted">{t.noResults.desc}</p>
            </div>
          ) : (
            <VirtualGrid
              groups={groups}
              renderCard={(entry) => (
                <VideoCard
                  key={entry.path}
                  entry={entry}
                  onOpen={handleOpen}
                  onToggleFavorite={handleToggleFavorite}
                  onRemove={handleRemove}
                  onRetry={handleRetry}
                />
              )}
            />
          )}
        </>
      )}

      <DropOverlay show={dragging} />
    </div>
  )
}
