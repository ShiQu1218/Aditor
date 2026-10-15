import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatTime } from '../../shared/time'
import { i18n } from '../i18n/zh-TW'
import { ChevronDown, Copy, FilePlus2, FolderOpen, Redo2, Save, Scissors, Trash2, Undo2 } from '../components/icons'
import type { Project, ProjectItem } from '../editor/project'
import type { SaveState } from '../editor/ProjectProvider'
import { dropIndex, itemWidth, trimFromDrag, trimUpperBound } from '../editor/trackLayout'
import { sourceBadge } from '../editor/sourceColors'

export interface ProjectTrackProps {
  project: Project
  /** 收合狀態（'auto' 的判定由呼叫端以 useMediaQuery 決定） */
  collapsed: boolean
  onToggleCollapsed: () => void
  /** 目前選取的片段（專案軌游標；Alt+←/→、Ctrl+D、Delete、Enter 作用對象） */
  selectedId: string | null
  onSelect: (id: string | null) => void
  /** 目前播放中的片段 id（專案模式；來源模式為 null） */
  currentId: string | null
  /** 目前片段內的進度 0..1 */
  progress: number
  /** 片段標籤（無對應片段時回「精華片段」） */
  labelOf: (item: ProjectItem) => string
  /** 來源缺失的片段 id（警示且不可預覽；由 ProjectProvider 衍生） */
  missingIds: ReadonlySet<string>
  /** 自動儲存狀態（軌頭小字） */
  saveState: SaveState
  /** 開啟的影片路徑（判斷片段來源是否為別的影片） */
  videoPath: string
  /** 開啟的影片長度（同影片的把手拖曳／步進上界） */
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
  /** 〔新專案〕：有片段時先開對話框；saveFirst=true 表示「另存檔案後新增」 */
  onNewProject: (saveFirst: boolean) => void
  onOpenFile: () => void
  onSaveFile: () => void
  /** ＋從來源加入：加入第一段待確認建議（沒有時 Toast） */
  onAddFromSource: () => void
  /** 新專案對話框開關（供呼叫端停用全域 keymap） */
  onDialogOpenChange: (open: boolean) => void
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

/** 0:42.8 形式的十進位秒（mock fmt1）。 */
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
 * 專案軌（spec §3.2、§3.7；Task 13）：片段卡＋軌頭＋新專案對話框。
 * 卡片：序號、標籤、長度、來源色點；sel＝白框、cur＝內框＋進度。
 * 互動：拖曳重排、兩端把手微調（命中區 ±6px、hover／選取才顯示）。
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
    onOpenFile,
    onSaveFile,
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
  // 來源順序＝專案內首次出現的順序（A、B、C… 穩定指派）
  const sources = useMemo(() => [...new Set(project.items.map((i) => i.source))], [project.items])

  useEffect(() => {
    setNameDraft(project.name)
  }, [project.name])

  useEffect(() => {
    onDialogOpenChange(newDlgOpen)
  }, [newDlgOpen, onDialogOpenChange])

  // 新專案對話框：Esc 取消（全域 keymap 開啟時已由呼叫端停用）
  useEffect(() => {
    if (!newDlgOpen) return
    dlgBoxRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing || e.keyCode === 229) return
      if (e.key === 'Escape') {
        e.preventDefault()
        setNewDlgOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newDlgOpen])

  const commitName = useCallback(() => {
    const trimmed = nameDraft.trim()
    if (trimmed && trimmed !== project.name) onRename(trimmed)
    else setNameDraft(project.name)
  }, [nameDraft, project.name, onRename])

  /* ---------------- 卡片：點擊＝選取＋播放（缺失來源只選取） ---------------- */

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

  /* ---------------- 把手（trimFromDrag；hover／選取才顯示） ---------------- */

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
      /* 指標已失效（例如合成事件）：仍可拖曳，只是沒有鎖定 */
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

  /* ---------------- 卡片：拖曳重排（dropIndex 中點判定） ---------------- */

  const handleCardDown = useCallback((e: React.PointerEvent<HTMLElement>, item: ProjectItem) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('.h')) return // 把手有自己的手勢
    orderRef.current = { id: item.id, startX: e.clientX, dragging: false }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* 指標已失效（例如合成事件）：仍可拖曳，只是沒有鎖定 */
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

  /* ---------------- 軌頭操作 ---------------- */

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
    if (project.items.length === 0) return // mock：空專案時不動作
    setNewDlgOpen(true)
  }, [project.items.length])

  const statusText = saveState === 'saving' ? t.saving : saveState === 'error' ? t.saveError : t.saved

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
          <button type="button" className="btn-ghost sm" onClick={onOpenFile}>
            {t.openFile}
          </button>
          <button type="button" className="btn-ghost sm" onClick={onSaveFile}>
            {t.saveFile}
          </button>
        </div>

        <div className="track" ref={trackRef} role="list" aria-label={t.title} tabIndex={0}>
          {project.items.length === 0 && <span className="dim track-empty">{t.empty}</span>}
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
                tabIndex={-1}
                className={`pclip${selectedId === item.id ? ' sel' : ''}${cur ? ' cur' : ''}${miss ? ' missing' : ''}${dragging ? ' drag-src' : ''}`}
                style={{ width: `${itemWidth(len)}px` }}
                title={miss ? t.missing : undefined}
                aria-label={t.itemAria
                  .replace('{i}', String(i + 1))
                  .replace('{label}', label)
                  .replace('{time}', formatTime(len))}
                onClick={() => handleCardClick(item)}
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
            aria-label={dlg.title}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <h3>{dlg.title}</h3>
            <div className="sub">
              {dlg.body.replace('{name}', project.name).replace('{n}', String(project.items.length))}
            </div>
            <div className="foot">
              <button type="button" className="btn-ghost" onClick={() => setNewDlgOpen(false)}>
                {dlg.cancel}
              </button>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => {
                  setNewDlgOpen(false)
                  onNewProject(true)
                }}
              >
                {dlg.saveThenNew}
              </button>
              <button
                type="button"
                className="btn-accent"
                onClick={() => {
                  setNewDlgOpen(false)
                  onNewProject(false)
                }}
              >
                {dlg.directNew}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
