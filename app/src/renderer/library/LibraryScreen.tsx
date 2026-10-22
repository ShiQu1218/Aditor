import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LibraryEntry } from '../../main/library'
import { DropOverlay } from './DropOverlay'
import { EmptyState } from './EmptyState'
import { LibraryToolbar } from './LibraryToolbar'
import { QueueStrip } from './QueueStrip'
import { VideoCard, fileName } from './VideoCard'
import { GAME_IDS, type GameId } from '../../shared/games'
import { resolveCardActivation, resolveLibraryEscape } from './cardLogic'
import { VirtualGrid } from './VirtualGrid'
import { isAllSelected, pruneSelection, selectAll, toggleGroup, toggleOne } from './selection'
import { CopyCheck, Trash2, X } from '../components/icons'
import { groupByDate } from '../lib/groupByDate'
import { useLocalNow } from '../lib/localDay'
import { filterEntries, type LibraryGame, type LibraryKind } from '../lib/libraryFilter'
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
  const [game, setGame] = useState<LibraryGame>('all')
  const [dragging, setDragging] = useState(false)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  /** A bulk removal is in flight; blocks a second Delete click from sending the same paths again. */
  const [deleting, setDeleting] = useState(false)
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

  const exitSelection = useCallback(() => {
    setSelectionMode(false)
    setSelected(new Set())
  }, [])

  useKeymap(
    {
      focusSearch: () => searchRef.current?.focus(),
      toggleFavoriteFilter: () => setFavoriteOnly((v) => !v),
      showShortcuts: overlay.openShortcuts,
      // Esc is handled only by keymap (IME composition is excluded), in priority order: open card menu → selection mode → search text → no action.
      closeOverlay: () => {
        const action = resolveLibraryEscape({ menuOpen: openMenuClose.current !== null, selecting: selectionMode, query: queryRef.current })
        if (action === 'close-menu') openMenuClose.current?.()
        else if (action === 'exit-selection') exitSelection()
        else if (action === 'clear-query') setQuery('')
      }
    },
    { screen: 'library' }
  )

  const filtered = useMemo(
    () => filterEntries(entries, { query, favoriteOnly, kind, game }),
    [entries, query, favoriteOnly, kind, game]
  )
  const now = useLocalNow() // Recalculate Today/Yesterday after local midnight or when the window regains focus.
  const groups = useMemo(() => groupByDate(filtered, now), [filtered, now])
  const counts = useMemo(() => {
    const base = { query: '', favoriteOnly: false, kind: 'all' as const, game: 'all' as const }
    const gameCounts = Object.fromEntries(
      GAME_IDS.map((id) => [id, filterEntries(entries, { ...base, game: id }).length])
    ) as Record<GameId, number>
    return {
      all: entries.length,
      knock: filterEntries(entries, { ...base, kind: 'knock' }).length,
      assist: filterEntries(entries, { ...base, kind: 'assist' }).length,
      hl: filterEntries(entries, { ...base, kind: 'hl' }).length,
      ...gameCounts
    }
  }, [entries])

  /** Every entry currently shown in the grid (the filtered list); "Select all" and the bar's disabled state use this. */
  const shownPaths = useMemo(() => filtered.map((entry) => entry.path), [filtered])
  const allShownSelected = isAllSelected(selected, shownPaths)

  // Selection hygiene: only shown entries stay selected, so removed entries and entries hidden by a filter or search
  // can never be deleted unseen. Same Set instance when nothing changed.
  useEffect(() => {
    setSelected((prev) => pruneSelection(prev, new Set(shownPaths)))
  }, [shownPaths])

  const handleToggleSelect = useCallback((path: string) => {
    setSelectionMode(true)
    setSelected((prev) => toggleOne(prev, path))
  }, [])

  const handleToggleGroup = useCallback(
    (groupIndex: number) => {
      const paths = groups[groupIndex]?.entries.map((entry) => entry.path) ?? []
      setSelectionMode(true)
      setSelected((prev) => toggleGroup(prev, paths))
    },
    [groups]
  )

  const handleSelectAll = useCallback(() => {
    setSelected((prev) => selectAll(prev, shownPaths))
  }, [shownPaths])

  const handleDeleteSelected = useCallback(async () => {
    const paths = Array.from(selected)
    if (paths.length === 0) return
    const hasRecording = entries.some((entry) => selected.has(entry.path) && entry.source === 'recording')
    const template = hasRecording ? t.selection.deleteSourceConfirm : t.selection.deleteConfirm
    if (!window.confirm(template.replace('{n}', String(paths.length)))) return
    setDeleting(true)
    try {
      const result = await window.api.library.removeMany(paths)
      const failed: string[] = Array.isArray(result?.failed) ? result.failed : []
      if (failed.length > 0) {
        toast({ message: t.selection.deleteFailed.replace('{n}', String(failed.length)) })
        setSelected(new Set(failed))
      } else {
        exitSelection()
      }
    } catch {
      toast({ message: t.selection.deleteFailed.replace('{n}', String(paths.length)) })
    } finally {
      setDeleting(false)
    }
  }, [entries, selected, toast, exitSelection])

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

  const renderCard = useCallback(
    (entry: LibraryEntry, active: boolean) => (
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
        selectionMode={selectionMode}
        selected={selected.has(entry.path)}
        onToggleSelect={handleToggleSelect}
      />
    ),
    [
      handleOpen,
      handleToggleFavorite,
      handleRemove,
      handleRetry,
      handleSetGame,
      handleMenuChange,
      proxySuggest,
      selectionMode,
      selected,
      handleToggleSelect
    ]
  )

  return (
    <div
      className={`lib-screen${selectionMode ? ' selecting' : ''}`}
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
            game={game}
            onGameChange={setGame}
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
              renderCard={renderCard}
              selectionMode={selectionMode}
              selected={selected}
              onToggleGroup={handleToggleGroup}
            />
          )}
          {selectionMode && (
            <div className="lib-selection-bar" role="toolbar" aria-label={t.selection.toolbar}>
              <span className="lib-selection-summary">
                <span className="lib-selection-count" aria-live="polite">
                  {selected.size}
                </span>
                <span className="lib-selection-label">{t.selection.selectedItems}</span>
              </span>
              <div className="lib-grow" />
              <button
                type="button"
                className="lib-selection-icon"
                title={t.selection.selectAll}
                aria-label={t.selection.selectAll}
                disabled={allShownSelected || shownPaths.length === 0}
                onClick={handleSelectAll}
              >
                <CopyCheck className="ic sm" />
              </button>
              <button
                type="button"
                className="lib-btn lib-selection-delete"
                disabled={selected.size === 0 || deleting}
                onClick={() => void handleDeleteSelected()}
              >
                <Trash2 className="ic sm" />
                {t.selection.deleteItems}
              </button>
              <button
                type="button"
                className="lib-selection-icon"
                title={t.selection.exit}
                aria-label={t.selection.exit}
                onClick={exitSelection}
              >
                <X className="ic sm" />
              </button>
            </div>
          )}
        </>
      )}

      <DropOverlay show={dragging} />
    </div>
  )
}
