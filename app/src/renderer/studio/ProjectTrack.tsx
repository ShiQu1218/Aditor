import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatTime } from '../../shared/time'
import { i18n } from '../i18n'
import { ChevronDown, Copy, Download, Redo2, Scissors, Trash2, Undo2 } from '../components/icons'
import type { Project, ProjectItem } from '../editor/project'
import type { SaveState } from '../editor/ProjectProvider'
import { useFocusTrap } from '../a11y/useFocusTrap'
import { rovingStep } from '../a11y/roving'
import { dropIndex, itemWidth, trimFromDrag, trimUpperBound } from '../editor/trackLayout'
import { sourceBadge } from '../editor/sourceColors'

export interface ProjectTrackProps {
  project: Project
  /** Collapsed state ('auto' is resolved by the caller with useMediaQuery). */
  collapsed: boolean
  onToggleCollapsed: () => void
  /** Currently selected clip (project-track cursor; target of Alt+←/→, Ctrl+D, Delete, and Enter). */
  selectedId: string | null
  onSelect: (id: string | null) => void
  /** Id of the currently playing clip in project mode; null in source mode. */
  currentId: string | null
  /** Progress within the current clip, from 0 to 1. */
  progress: number
  /** Clip label (falls back to “Highlight Clip” when no label matches). */
  labelOf: (item: ProjectItem) => string
  /** Clip ids with missing sources (warn and disable preview; derived by ProjectProvider). */
  missingIds: ReadonlySet<string>
  /** Autosave state (small text in the track header). */
  saveState: SaveState
  /** Path of the open video (used to detect clips from another video). */
  videoPath: string
  /** Duration of the open video (upper bound for handle dragging/stepping on the same video). */
  videoDuration: number
  onPlay: (item: ProjectItem) => void
  onMissing: () => void
  onTrim: (id: string, edge: 'start' | 'end', t: number) => void
  onMove: (id: string, toIndex: number) => void
  onRename: (name: string) => void
  onSplit: () => void
  onDuplicate: () => void
  onDelete: () => void
  onUndo: () => void
  onRedo: () => void
  canUndo: boolean
  canRedo: boolean
  onNewProject: () => void
  onAddExternalVideo: () => void
  onExport: () => void
  exportOpen: boolean
  exportPercent: number | null
  /** Add from Source: add the first pending suggestion (show a Toast if none exists). */
  onAddFromSource: () => void
  /** New-project dialog state (lets the caller disable the global keymap). */
  onDialogOpenChange: (open: boolean) => void
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

/** Decimal seconds in the 0:42.8 format (mock fmt1). */
function fmt1(t: number): string {
  return `${formatTime(t)}.${Math.floor((t % 1) * 10)}`
}

interface TrimDrag {
  id: string
  edge: 'start' | 'end'
  start: number
  end: number
}
interface ReorderDrag {
  id: string
  insertAt: number
  x: number
}

/**
 * Project track (spec §3.2, §3.7; Task 13): clip cards, track header, and new-project dialog.
 * Cards show sequence, label, duration, and source color; sel has a white border, while cur has an inset border and progress.
 * Interactions: drag to reorder and trim with handles at either end (±6px hit area; visible on hover or selection).
 */
export function ProjectTrack(props: ProjectTrackProps): JSX.Element {
  const {
    project,
    collapsed,
    onToggleCollapsed,
    selectedId,
    onSelect,
    currentId,
    progress,
    labelOf,
    missingIds,
    saveState,
    videoPath,
    videoDuration,
    onPlay,
    onMissing,
    onTrim,
    onMove,
    onRename,
    onSplit,
    onDuplicate,
    onDelete,
    onUndo,
    onRedo,
    canUndo,
    canRedo,
    onNewProject,
    onAddExternalVideo,
    onExport,
    exportOpen,
    exportPercent,
    onAddFromSource,
    onDialogOpenChange
  } = props

  const t = i18n.studio.track
  const dlg = i18n.studio.newProjectDlg

  const [nameDraft, setNameDraft] = useState(project.name)
  const [trimDrag, setTrimDrag] = useState<TrimDrag | null>(null)
  const [reorder, setReorder] = useState<ReorderDrag | null>(null)
  const [newDlgOpen, setNewDlgOpen] = useState(false)
  const trackRef = useRef<HTMLDivElement>(null)
  const trimRef = useRef<{ item: ProjectItem; edge: 'start' | 'end'; startX: number; pxPerSec: number; upper: number; moved: boolean } | null>(null)
  const orderRef = useRef<{ id: string; startX: number; dragging: boolean } | null>(null)
  const insertRef = useRef<number | null>(null)
  const suppressClickRef = useRef(false)
  const dlgBoxRef = useRef<HTMLDivElement>(null)

  const total = project.items.reduce((sum, i) => sum + Math.max(0, i.end - i.start), 0)
  // Source order follows each source's first appearance in the project (stable A, B, C… assignment).
  const sources = useMemo(() => [...new Set(project.items.map((i) => i.source))], [project.items])

  useEffect(() => {
    setNameDraft(project.name)
  }, [project.name])

  // Roving tabindex: the selected clip (or first clip when none is selected) is the track's only Tab stop.
  const rovingId = project.items.some((i) => i.id === selectedId) ? selectedId : (project.items[0]?.id ?? null)
  /** Focus is on a track clip (move focus to the newly selected clip only after keyboard selection, reorder, or deletion). */
  const focusInTrack = useRef(false)

  useEffect(() => {
    if (!focusInTrack.current || !selectedId) return
    const track = trackRef.current
    const el = track ? Array.from(track.querySelectorAll<HTMLElement>('[data-item-id]')).find((c) => c.dataset.itemId === selectedId) : undefined
    if (!el) return
    const active = document.activeElement as HTMLElement | null
    if (active === el || (active && el.contains(active))) return
    if (active === null || active === document.body || active.closest('.pclip')) el.focus()
  }, [selectedId, project.items])

  /** Home/End jumps to the first/last clip when focus is on a clip (←→ is handled by keymap's selectPrevItem/selectNextItem). */
  const onChipKeyDown = (e: React.KeyboardEvent<HTMLElement>): void => {
    if ((e.key !== 'Home' && e.key !== 'End') || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.nativeEvent.isComposing) return
    if (!(e.target as HTMLElement).classList.contains('pclip')) return
    const at = project.items.findIndex((i) => i.id === rovingId)
    const next = rovingStep({ count: project.items.length, index: at, key: e.key, columns: 1, orientation: 'horizontal' })
    if (next === null) return
    e.preventDefault()
    onSelect(project.items[next].id)
  }

  useEffect(() => {
    onDialogOpenChange(newDlgOpen)
  }, [newDlgOpen, onDialogOpenChange])

  // New-project dialog focus trap (focus the first option on open, keep Tab inside, handle Esc once, and restore focus on close).
  useFocusTrap(dlgBoxRef, { active: newDlgOpen, onEscape: () => setNewDlgOpen(false) })

  const commitName = useCallback(() => {
    const trimmed = nameDraft.trim()
    if (trimmed && trimmed !== project.name) onRename(trimmed)
    else setNameDraft(project.name)
  }, [nameDraft, project.name, onRename])

  /* ---------------- Cards: click selects and plays (missing sources are selected only) ---------------- */

  const handleCardClick = useCallback(
    (item: ProjectItem) => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false
        return
      }
      onSelect(item.id)
      if (missingIds.has(item.id)) onMissing()
      else onPlay(item)
    },
    [onSelect, onPlay, onMissing, missingIds]
  )

  /* ---------------- Handles (trimFromDrag; visible on hover or selection) ---------------- */

  const handleTrimDown = useCallback((e: React.PointerEvent<HTMLElement>, item: ProjectItem, edge: 'start' | 'end') => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const card = e.currentTarget.closest('.pclip') as HTMLElement | null
    const width = card?.offsetWidth ?? itemWidth(item.end - item.start)
    const len = Math.max(0.001, item.end - item.start)
    trimRef.current = { item: { ...item }, edge, startX: e.clientX, pxPerSec: width / len, upper: trimUpperBound(item.source, videoPath, videoDuration), moved: false }
    suppressClickRef.current = true
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* Pointer is unavailable (for example, in a synthetic event); dragging still works without pointer capture. */
    }
    setTrimDrag({ id: item.id, edge, start: item.start, end: item.end })
  }, [videoPath, videoDuration])

  const handleTrimMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const d = trimRef.current
      if (!d) return
      const dx = e.clientX - d.startX
      if (Math.abs(dx) > 2) d.moved = true
      const next = trimFromDrag(d.item, d.edge, dx, d.pxPerSec, d.upper)
      setTrimDrag({ id: d.item.id, edge: d.edge, start: next.start, end: next.end })
    },
    []
  )

  const handleTrimEnd = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const d = trimRef.current
      trimRef.current = null
      setTrimDrag(null)
      if (!d) return
      const dx = e.clientX - d.startX
      if (!d.moved) return
      const next = trimFromDrag(d.item, d.edge, dx, d.pxPerSec, d.upper)
      onTrim(d.item.id, d.edge, d.edge === 'start' ? next.start : next.end)
    },
    [onTrim]
  )

  const handleTrimCancel = useCallback(() => {
    trimRef.current = null
    setTrimDrag(null)
  }, [])

  /* ---------------- Cards: drag to reorder (dropIndex uses midpoints) ---------------- */

  const handleCardDown = useCallback((e: React.PointerEvent<HTMLElement>, item: ProjectItem) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('.h')) return // Handles have their own gesture.
    orderRef.current = { id: item.id, startX: e.clientX, dragging: false }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* Pointer is unavailable (for example, in a synthetic event); dragging still works without pointer capture. */
    }
  }, [])

  const handleCardMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const o = orderRef.current
    if (!o) return
    const dx = e.clientX - o.startX
    if (!o.dragging && Math.abs(dx) < 5) return
    o.dragging = true
    suppressClickRef.current = true
    const track = trackRef.current
    if (!track) return
    const cards = Array.from(track.querySelectorAll<HTMLElement>('[data-item-id]'))
    const xs = cards.map((c) => c.offsetLeft)
    const widths = cards.map((c) => c.offsetWidth)
    const rect = track.getBoundingClientRect()
    const pointerX = e.clientX - rect.left + track.scrollLeft
    const insertAt = dropIndex(xs, widths, pointerX)
    const last = xs.length - 1
    const x =
      insertAt < xs.length && xs.length > 0
        ? xs[insertAt] - 3
        : last >= 0
          ? xs[last] + widths[last] + 3
          : 0
    insertRef.current = insertAt
    setReorder({ id: o.id, insertAt, x })
  }, [])

  const handleCardUp = useCallback(() => {
    const o = orderRef.current
    orderRef.current = null
    const insertAt = insertRef.current
    insertRef.current = null
    if (!o?.dragging || insertAt === null) {
      setReorder(null)
      return
    }
    suppressClickRef.current = true
    setReorder(null)
    const from = project.items.findIndex((i) => i.id === o.id)
    const to = insertAt > from ? insertAt - 1 : insertAt
    const clamped = Math.max(0, Math.min(project.items.length - 1, to))
    if (from >= 0 && clamped !== from) onMove(o.id, clamped)
  }, [project.items, onMove])

  const handleCardCancel = useCallback(() => {
    orderRef.current = null
    insertRef.current = null
    setReorder(null)
  }, [])

  /* ---------------- Track-header actions ---------------- */

  const sel = selectedId ? project.items.find((i) => i.id === selectedId) ?? null : null
  const selIndex = sel ? project.items.findIndex((i) => i.id === sel.id) : -1

  const nudge = useCallback(
    (edge: 'start' | 'end', delta: number) => {
      if (!sel) return
      onTrim(sel.id, edge, (edge === 'start' ? sel.start : sel.end) + delta)
    },
    [sel, onTrim]
  )

  const requestNewProject = useCallback(() => {
    if (project.items.length === 0) return // Mock: do nothing for an empty project.
    setNewDlgOpen(true)
  }, [project.items.length])

  const statusText = saveState === 'saving' ? t.saving : saveState === 'error' ? t.saveError : saveState === 'pending' ? t.pending : t.saved

  return (
    <section
      className={`project-lane${collapsed ? ' collapsed' : ''}`}
      data-zone="proj"
      aria-label={t.title}
    >
      <div className="lane-label">
        <span>{t.title}</span>
        <small>{formatTime(total)}</small>
      </div>

      <div className="plane">
        <div className="plane-head">
          <div className="plane-head-edit" data-editor-lock>
            <button
              type="button"
              className="icon-btn fold"
              title={t.collapse}
              aria-label={t.collapse}
              aria-expanded={!collapsed}
              onClick={onToggleCollapsed}
            >
              <ChevronDown className="ic sm" />
            </button>
            <input
              className="pname"
              value={nameDraft}
              aria-label={t.nameLabel}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
                else if (e.key === 'Escape') {
                  e.currentTarget.value = project.name
                  setNameDraft(project.name)
                  ;(e.currentTarget as HTMLInputElement).blur()
                }
              }}
            />
            <span className="proj-info dim">
              {t.itemCount.replace('{n}', String(project.items.length))} · {t.total.replace('{time}', formatTime(total))}
              <span className="xtra"> · {t.sources.replace('{n}', String(sources.length))}</span>
            </span>
            <span className={`sub-save ${saveState}`} title={statusText}>
              <i />
              {statusText}
            </span>
            <span className="grow" />
            {sel && (
              <span className="insp">
                <span className="dim">#{selIndex + 1}</span>
                <span className="stepper">
                  <button type="button" aria-label={`${t.stepperStart} ${t.stepperDec}`} onClick={() => nudge('start', -0.5)}>
                    −
                  </button>
                  <span>{fmt1(sel.start)}</span>
                  <button type="button" aria-label={`${t.stepperStart} ${t.stepperInc}`} onClick={() => nudge('start', 0.5)}>
                    +
                  </button>
                </span>
                <span className="dim">→</span>
                <span className="stepper">
                  <button type="button" aria-label={`${t.stepperEnd} ${t.stepperDec}`} onClick={() => nudge('end', -0.5)}>
                    −
                  </button>
                  <span>{fmt1(sel.end)}</span>
                  <button type="button" aria-label={`${t.stepperEnd} ${t.stepperInc}`} onClick={() => nudge('end', 0.5)}>
                    +
                  </button>
                </span>
              </span>
            )}
            <button type="button" className="icon-btn" title={t.splitTitle} aria-label={t.split} onClick={onSplit}>
              <Scissors className="ic sm" />
            </button>
            <button type="button" className="icon-btn" title={t.duplicate} aria-label={t.duplicate} disabled={!sel} onClick={onDuplicate}>
              <Copy className="ic sm" />
            </button>
            <button type="button" className="icon-btn" title={t.delete} aria-label={t.delete} disabled={!sel} onClick={onDelete}>
              <Trash2 className="ic sm" />
            </button>
            <button type="button" className="icon-btn" title={t.undo} aria-label={t.undo} disabled={!canUndo} onClick={onUndo}>
              <Undo2 className="ic sm" />
            </button>
            <button type="button" className="icon-btn" title={t.redo} aria-label={t.redo} disabled={!canRedo} onClick={onRedo}>
              <Redo2 className="ic sm" />
            </button>
            <button type="button" className="btn-ghost sm" onClick={requestNewProject}>
              {t.newProject}
            </button>
            <button type="button" className="btn-ghost sm" onClick={onAddExternalVideo}>
              {t.addExternalVideo}
            </button>
          </div>
          <button
            type="button"
            className="btn-accent sm"
            aria-haspopup="dialog"
            aria-expanded={exportOpen}
            aria-label={exportPercent !== null ? i18n.export.badgeLabel.replace('{pct}', String(exportPercent)) : undefined}
            onClick={onExport}
          >
            <Download className="ic sm" /> {i18n.studio.exportCount.replace('{n}', String(project.items.length))}
            {exportPercent !== null && <span className="xd-badge">{i18n.export.badge.replace('{pct}', String(exportPercent))}</span>}
          </button>
        </div>

        <div
          className="track"
          data-editor-lock
          ref={trackRef}
          onFocus={() => {
            focusInTrack.current = true
          }}
          onBlur={(e) => {
            const to = e.relatedTarget as Node | null
            if (to && !e.currentTarget.contains(to)) focusInTrack.current = false
          }}
        >
          {project.items.length === 0 && <span className="dim track-empty">{t.empty}</span>}
          {/* The list itself contains clips only (listitem); keep the Add from Source button and insertion line outside it (display: contents does not affect layout). */}
          <div className="track-list" role="list" aria-label={t.title}>
          {project.items.map((item, i) => {
            const dragging = reorder?.id === item.id
            const preview = trimDrag?.id === item.id ? trimDrag : null
            const start = preview ? preview.start : item.start
            const end = preview ? preview.end : item.end
            const len = Math.max(0, end - start)
            const cur = currentId === item.id
            const badge = sourceBadge(item.source, sources)
            const miss = missingIds.has(item.id)
            const label = labelOf(item)
            return (
              <div
                key={item.id}
                data-item-id={item.id}
                role="listitem"
                tabIndex={item.id === rovingId ? 0 : -1}
                aria-current={selectedId === item.id ? 'true' : undefined}
                className={`pclip${selectedId === item.id ? ' sel' : ''}${cur ? ' cur' : ''}${miss ? ' missing' : ''}${dragging ? ' drag-src' : ''}`}
                style={{ width: `${itemWidth(len)}px` }}
                title={miss ? t.missing : undefined}
                aria-label={t.itemAria
                  .replace('{i}', String(i + 1))
                  .replace('{label}', label)
                  .replace('{time}', formatTime(len))}
                onClick={() => handleCardClick(item)}
                onFocus={(e) => {
                  // Focus entering a clip (Tab/click) selects it; there are no nested controls (handles are <i> elements).
                  if (e.target === e.currentTarget && selectedId !== item.id) onSelect(item.id)
                }}
                onKeyDown={onChipKeyDown}
                onPointerDown={(e) => handleCardDown(e, item)}
                onPointerMove={handleCardMove}
                onPointerUp={handleCardUp}
                onPointerCancel={handleCardCancel}
              >
                <span className="idx">#{i + 1}</span>
                <span className="src" style={{ background: badge.colorVar }} title={item.source}>
                  {badge.letter}
                </span>
                <i
                  className="h l"
                  onPointerDown={(e) => handleTrimDown(e, item, 'start')}
                  onPointerMove={handleTrimMove}
                  onPointerUp={handleTrimEnd}
                  onPointerCancel={handleTrimCancel}
                />
                <i
                  className="h r"
                  onPointerDown={(e) => handleTrimDown(e, item, 'end')}
                  onPointerMove={handleTrimMove}
                  onPointerUp={handleTrimEnd}
                  onPointerCancel={handleTrimCancel}
                />
                <div className="cap">
                  <span>{label}</span>
                  <span className="mono">{formatTime(len)}</span>
                </div>
                {cur && progress > 0 && <span className="prog" style={{ width: `${Math.round(clamp01(progress) * 100)}%` }} />}
              </div>
            )
          })}
          </div>
          {reorder && <span className="drop-line" style={{ left: `${reorder.x}px` }} />}
          <button type="button" className="add-slot" onClick={onAddFromSource}>
            <span aria-hidden="true">＋</span>
            <span>{t.addFromSource}</span>
            <span className="dim">{t.addKey}</span>
          </button>
        </div>
      </div>

      {newDlgOpen && (
        <div className="np-host" onClick={() => setNewDlgOpen(false)}>
          <div
            ref={dlgBoxRef}
            className="np-dlg"
            role="dialog"
            aria-modal="true"
            aria-labelledby="np-title"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="np-title">{dlg.title}</h3>
            <div className="sub">
              {dlg.body
                .replace('{name}', project.name)
                .replace('{n}', String(project.items.length))}
            </div>
            <div className="foot">
              <button type="button" className="btn-ghost" onClick={() => setNewDlgOpen(false)}>
                {dlg.cancel}
              </button>
              <button
                type="button"
                className="btn-accent"
                onClick={() => {
                  setNewDlgOpen(false)
                  onNewProject()
                }}
              >
                {dlg.confirm}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
