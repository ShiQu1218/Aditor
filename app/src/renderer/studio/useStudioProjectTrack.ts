import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { Clip } from '../../shared/types'
import { importExternalVideos } from '../editor/externalVideos'
import { addItems, duplicateItem, moveItem, removeItem, trimItem, type Project, type ProjectItem } from '../editor/project'
import { i18n } from '../i18n'
import type { useToast } from '../shell/ToastHost'
import type { createExportController } from './exportController'
import { isSuggested } from './highlights'
import type { StudioSettings } from './studioSettings'
import { baseName, normPath } from './studioScreenModel'

interface StudioProjectTrackOptions {
  project: Project
  projectRef: MutableRefObject<Project>
  apply: (next: Project) => void
  newProject: () => boolean
  /** Id of the project being edited (its file is the one deleted by "also delete the current project"). */
  projectId: string
  openProject: (id: string) => Promise<boolean>
  toast: ReturnType<typeof useToast>
  exportCtl: ReturnType<typeof createExportController>
  videoPath: string
  duration: number
  selProjId: string | null
  setSelProjId: (id: string | null) => void
  setSourceTrim: (trim: { id: string; edge: 'start' | 'end'; t: number } | null) => void
  projCollapsed: boolean
  setSettings: Dispatch<SetStateAction<StudioSettings | null>>
  playProjectItem: (item: ProjectItem) => void
  mountedRef: MutableRefObject<boolean>
  switchingSourceRef: MutableRefObject<boolean>
  shownClips: Clip[]
  acceptClip: (clip: Clip) => void
}

/** Project-track operations (Task 13): selection, trimming, reordering, duplication, deletion, and imports. */
export function useStudioProjectTrack({
  project,
  projectRef,
  apply,
  newProject,
  projectId,
  openProject,
  toast,
  exportCtl,
  videoPath,
  duration,
  selProjId,
  setSelProjId,
  setSourceTrim,
  projCollapsed,
  setSettings,
  playProjectItem,
  mountedRef,
  switchingSourceRef,
  shownClips,
  acceptClip
}: StudioProjectTrackOptions) {
  const importingRef = useRef(false)
  const currentProjectId = useRef(projectId)
  currentProjectId.current = projectId

  // Keep selection in sync with clip changes: select the first clip when a project becomes non-empty; clear selection if the clip is deleted or the project changes.
  const prevItemCount = useRef(0)
  useEffect(() => {
    const n = project.items.length
    if (prevItemCount.current === 0 && n > 0) setSelProjId(project.items[0].id)
    else if (selProjId !== null && !project.items.some((i) => i.id === selProjId)) setSelProjId(null)
    prevItemCount.current = n
  }, [project.items, selProjId])

  /** Handle/step adjustments: clamp to video duration for the same source; other sources have no upper bound because their durations are unknown. */
  const trimProjectItem = useCallback(
    (id: string, edge: 'start' | 'end', t: number) => {
      const item = projectRef.current.items.find((i) => i.id === id)
      const sameVideo = item ? normPath(item.source) === normPath(videoPath) : true
      apply(trimItem(projectRef.current, id, edge, t, sameVideo ? duration : undefined))
    },
    [apply, videoPath, duration]
  )

  /** Dragging updates only the display draft; commit one undoable edit through the existing API at the end. */
  const trimSourceProjectItem = useCallback((id: string, edge: 'start' | 'end', t: number, phase: 'preview' | 'commit' | 'cancel'): void => {
    if (phase === 'preview') setSourceTrim({ id, edge, t })
    else {
      setSourceTrim(null)
      const item = projectRef.current.items.find((item) => item.id === id)
      if (phase === 'commit' && item) {
        const next = trimItem(projectRef.current, id, edge, t, duration)
        const trimmed = next.items.find((item) => item.id === id)!
        if (trimmed.start !== item.start || trimmed.end !== item.end) trimProjectItem(id, edge, t)
      }
    }
  }, [duration, trimProjectItem])

  const moveProjectItem = useCallback(
    (id: string, toIndex: number) => {
      apply(moveItem(projectRef.current, id, toIndex))
    },
    [apply]
  )

  const renameProject = useCallback(
    (name: string) => {
      apply({ ...projectRef.current, name })
    },
    [apply]
  )

  /** Duplicate the selected clip (Ctrl+D or track head) and select the copy placed after the original. */
  const duplicateSelectedItem = useCallback(() => {
    const id = selProjId
    if (!id) return
    const before = new Set(projectRef.current.items.map((i) => i.id))
    const next = duplicateItem(projectRef.current, id)
    if (next === projectRef.current) return
    apply(next)
    const clone = next.items.find((i) => !before.has(i.id))
    if (clone) setSelProjId(clone.id)
  }, [selProjId, apply])

  /** Restore only this deletion so the notification cannot undo later edits or change another project. */
  const deleteSelectedItem = useCallback(() => {
    const id = selProjId
    if (!id) return
    // Select an adjacent clip after deletion (prefer the next one) so keyboard focus does not fall to body.
    const items = projectRef.current.items
    const at = items.findIndex((i) => i.id === id)
    if (at < 0) return
    const deleted = items[at]
    const neighbor = items[at + 1] ?? items[at - 1] ?? null
    apply(removeItem(projectRef.current, id))
    setSelProjId(neighbor ? neighbor.id : null)
    toast({
      message: i18n.studio.toast.deletedItem,
      action: { label: i18n.studio.toast.undo, run: function undoDeletion() {
        if (!mountedRef.current || currentProjectId.current !== projectId) return
        const current = projectRef.current
        if (current.items.some((item) => item.id === id)) return
        const restored = [...current.items]
        restored.splice(Math.min(at, restored.length), 0, deleted)
        apply({ ...current, items: restored })
      } }
    })
  }, [selProjId, apply, toast, projectId, projectRef, mountedRef])

  /** ←/→ moves the selected clip; when none is selected, select the first/last clip. */
  const selectProjectItem = useCallback(
    (dir: 1 | -1) => {
      const items = projectRef.current.items
      if (items.length === 0) return
      const at = selProjId ? items.findIndex((i) => i.id === selProjId) : -1
      const next = at < 0 ? (dir === 1 ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, at + dir))
      setSelProjId(items[next].id)
    },
    [selProjId]
  )

  /** Alt+←/→ moves the selected clip one position forward or backward. */
  const shiftSelectedItem = useCallback(
    (dir: 1 | -1) => {
      const id = selProjId
      if (!id) return
      const items = projectRef.current.items
      const at = items.findIndex((i) => i.id === id)
      const to = at + dir
      if (at < 0 || to < 0 || to >= items.length) return
      apply(moveItem(projectRef.current, id, to))
    },
    [selProjId, apply]
  )

  /** Enter plays the selected clip. */
  const playSelectedItem = useCallback(() => {
    const item = selProjId ? projectRef.current.items.find((i) => i.id === selProjId) : undefined
    if (item) playProjectItem(item)
  }, [selProjId, playProjectItem])

  /** Collapse/expand the project track and save a boolean to settings.projectTrackCollapsed, overriding 'auto'. */
  const toggleProjCollapsed = useCallback(() => {
    const next = !projCollapsed
    void window.api?.settings?.set?.({ projectTrackCollapsed: next })
    setSettings((prev) => (prev ? { ...prev, projectTrackCollapsed: next } : prev))
  }, [projCollapsed])

  /** The session synchronously saves the old project before creating a new one; keep current content if saving fails. */
  const handleNewProjectConfirmed = useCallback(
    async (deleteOld = false): Promise<void> => {
      const oldId = projectId
      if (!newProject()) return
      setSelProjId(null)
      prevItemCount.current = 0
      if (deleteOld) {
        // The old file was just flushed by newProject(); remove it only after that succeeded.
        try {
          await window.api.projects.remove(oldId)
          toast({ message: i18n.studio.toast.newProjectDeletedOld })
        } catch {
          toast({ message: `${i18n.studio.toast.newProject} ${i18n.studio.projectManagerDlg.removeFailed}` })
        }
        return
      }
      toast({ message: i18n.studio.toast.newProject })
    },
    [newProject, projectId, toast]
  )

  /** Switch to a stored project from the manager dialog. */
  const handleOpenProject = useCallback(
    async (id: string): Promise<boolean> => {
      if (!(await openProject(id))) {
        toast({ message: i18n.studio.toast.openProjectFailed })
        return false
      }
      setSelProjId(null)
      prevItemCount.current = 0
      toast({ message: i18n.studio.toast.projectOpened })
      return true
    },
    [openProject, toast]
  )

  /** Add all external videos to the project in one undoable action; first play the first new clip whose duration was obtained. */
  const handleAddExternalVideo = useCallback(() => {
    if (importingRef.current || exportCtl.getState().phase === 'running') return
    importingRef.current = true
    void (async () => {
      try {
        const api = window.api
        if (!api) return
        const paths: string[] = await api.library.selectFiles()
        if (paths.length === 0 || !mountedRef.current) return
        const { items, failed } = await importExternalVideos(paths, api)
        if (!mountedRef.current || switchingSourceRef.current) return
        if (failed.length) toast({ message: i18n.studio.toast.externalVideoIncomplete.replace('{names}', failed.map(baseName).join('、')) })
        if (exportCtl.getState().phase === 'running') {
          toast({ message: i18n.export.backBlocked })
          return
        }
        if (!items.length) return
        const firstIndex = projectRef.current.items.length
        const next = addItems(projectRef.current, items)
        apply(next)
        playProjectItem(next.items[firstIndex])
      } catch {
        toast({ message: i18n.studio.toast.addExternalFailed })
      } finally {
        importingRef.current = false
      }
    })()
  }, [toast, exportCtl, apply, playProjectItem])

  /** Add from source: add the first pending suggestion (mock behavior); show a Toast when none exists. */
  const addFirstSuggestion = useCallback(() => {
    const clip = shownClips.find(isSuggested)
    if (clip) acceptClip(clip)
    else toast({ message: i18n.studio.toast.noSuggestions })
  }, [shownClips, acceptClip, toast])

  return {
    trimProjectItem,
    trimSourceProjectItem,
    moveProjectItem,
    renameProject,
    duplicateSelectedItem,
    deleteSelectedItem,
    selectProjectItem,
    shiftSelectedItem,
    playSelectedItem,
    toggleProjCollapsed,
    handleNewProjectConfirmed,
    handleOpenProject,
    handleAddExternalVideo,
    addFirstSuggestion
  }
}
