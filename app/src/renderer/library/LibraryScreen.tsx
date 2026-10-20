import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LibraryEntry } from '../../main/library'
import { DropOverlay } from './DropOverlay'
import { EmptyState } from './EmptyState'
import { LibraryToolbar } from './LibraryToolbar'
import { QueueStrip } from './QueueStrip'
import { VideoCard, fileName } from './VideoCard'
import type { GameId } from '../../shared/games'
import { resolveCardActivation, resolveLibraryEscape } from './cardLogic'
import { VirtualGrid } from './VirtualGrid'
import { groupByDate } from '../lib/groupByDate'
import { useLocalNow } from '../lib/localDay'
import { filterEntries, type LibraryKind } from '../lib/libraryFilter'
import { useKeymap } from '../hooks/useShortcuts'
import { useToast } from '../shell/ToastHost'
import { useOverlay } from '../shell/OverlayHost'
import { useQueueStore } from '../queue/QueueProvider'
import { i18n } from '../i18n'
import { subscribeStudioSettings } from '../studio/studioSettings'
import { library500Requested } from '../dev/libraryFixtureFlag'

const t = i18n.library

interface LibraryScreenProps {
  onSelectVideo: (path: string) => void
  onOpenSettings: () => void
}

export function LibraryScreen({ onSelectVideo, onOpenSettings }: LibraryScreenProps): JSX.Element {
  const toast = useToast()
  const overlay = useOverlay()
  const queueStore = useQueueStore()
  const [entries, setEntries] = useState<LibraryEntry[]>([])
  const [query, setQuery] = useState('')
  const [favoriteOnly, setFavoriteOnly] = useState(false)
  const [kind, setKind] = useState<LibraryKind>('all')
  const [dragging, setDragging] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const queryRef = useRef(query)
  queryRef.current = query
  // Proxy suggestion setting (immediate): when disabled, cards hide the proxy-suggestion badge.
  const [proxySuggest, setProxySuggest] = useState(true)
  // Show one notice when the library file is corrupt (main has already backed it up).
  useEffect(() => {
    void window.api?.library?.getLoadNotice?.()?.then((p: string | null) => {
      if (p) toast({ message: t.corruptNotice.replace('{path}', p) })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => subscribeStudioSettings(window.api, (s) => setProxySuggest(s.proxySuggest)), [])
  const openMenuClose = useRef<(() => void) | null>(null)
  const handleMenuChange = useCallback((_path: string, close: (() => void) | null) => {
    openMenuClose.current = close
  }, [])

  // Main already throttles library:updated to at most once every 500 ms (including a trailing event); do not throttle again here.
  const load = useCallback(async () => {
    if (library500Requested()) {
      // Development only: load dynamically so production builds exclude synthetic data (see libraryFixtureFlag).
      const m = await import('../dev/libraryFixture')
      setEntries(m.libraryFixtureOnce())
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
      showShortcuts: overlay.openShortcuts,
      // Esc is handled only by keymap (IME composition is excluded), in priority order: open card menu → search text → no action.
      closeOverlay: () => {
        const action = resolveLibraryEscape({ menuOpen: openMenuClose.current !== null, query: queryRef.current })
        if (action === 'close-menu') openMenuClose.current?.()
        else if (action === 'clear-query') setQuery('')
      }
    },
    { screen: 'library' }
  )

  const filtered = useMemo(() => filterEntries(entries, { query, favoriteOnly, kind }), [entries, query, favoriteOnly, kind])
  const now = useLocalNow() // Recalculate Today/Yesterday after local midnight or when the window regains focus.
  const groups = useMemo(() => groupByDate(filtered, now), [filtered, now])
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
      const action = resolveCardActivation(entry, queueStore.stateOf(entry.path))
      if (action === 'open') onSelectVideo(entry.path)
      else if (action === 'toast-not-analyzed') toast({ message: t.card.notAnalyzedToast })
      else if (action === 'toast-blocked') toast({ message: t.card.openBlocked })
    },
    [onSelectVideo, toast, queueStore]
  )

  const handleToggleFavorite = useCallback((path: string) => {
    void window.api?.library?.toggleFavorite?.(path)
  }, [])

  const handleRemove = useCallback(async (path: string) => {
    const entry = entries.find((entry) => entry.path === path)
    const message = entry?.source === 'recording' ? t.card.removeSourceConfirm : t.card.removeConfirm
    const confirmed = window.confirm(message.replace('{name}', fileName(path)))
    if (!confirmed) return
    try {
      await window.api.library.remove(path)
    } catch {
      toast({ message: t.card.removeFailed })
    }
  }, [entries, toast])

  const handleRetry = useCallback((path: string) => {
    void window.api?.queue?.enqueue?.(path)
  }, [])

  const handleSetGame = useCallback((path: string, game: GameId) => {
    void window.api?.library?.setGame?.(path, game)
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)
      const files = Array.from(e.dataTransfer.files)
      if (files.length > 0) {
        void window.api?.library?.addDroppedFiles?.(files)
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
        // Dismiss the overlay only when leaving the entire screen.
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
      }}
      onDrop={handleDrop}
    >
      <header className="lib-topbar">
        <h1>{t.title}</h1>
        <div className="lib-grow" />
        <button type="button" className="lib-btn" onClick={handleImportFolder}>
          {t.importFolder}
        </button>
        <button type="button" className="lib-btn primary" onClick={handleImportFiles}>
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
              renderCard={(entry, active) => (
                <VideoCard
                  key={entry.path}
                  entry={entry}
                  onOpen={handleOpen}
                  onToggleFavorite={handleToggleFavorite}
                  onRemove={handleRemove}
                  onRetry={handleRetry}
                  onSetGame={handleSetGame}
                  onMenuChange={handleMenuChange}
                  proxySuggest={proxySuggest}
                  active={active}
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
