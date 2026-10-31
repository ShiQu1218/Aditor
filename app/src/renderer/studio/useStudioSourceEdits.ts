import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react'
import type { Clip } from '../../shared/types'
import type { ViewerAction } from '../viewer/state'
import { addItems, splitItem, type Project, type ProjectItem } from '../editor/project'
import type { Command } from '../input/keymap'
import { i18n } from '../i18n'
import type { useToast } from '../shell/ToastHost'
import {
  acceptToProject,
  findItemsForClip,
  isSuggested,
  nextSuggestion,
  planAccept,
  planAddAll,
  removeProjectItems
} from './highlights'
import type { ModeAction, ModeState } from './mode'
import { guardCommand, SourceEditCommand } from './modeGuard'

interface StudioSourceEditsOptions {
  videoPath: string
  videoRef: RefObject<HTMLVideoElement>
  mode: ModeState
  modeRef: MutableRefObject<ModeState>
  dispatchMode: Dispatch<ModeAction>
  dispatch: Dispatch<ViewerAction>
  apply: (next: Project) => void
  toast: ReturnType<typeof useToast>
  projectRef: MutableRefObject<Project>
  projectId: string
  mountedRef: MutableRefObject<boolean>
  previewRef: MutableRefObject<{ item: ProjectItem | null }>
  currentTime: number
  shownClips: Clip[]
  activeClipId: string | null
  setActiveClipId: Dispatch<SetStateAction<string | null>>
  setSelProjId: (id: string | null) => void
  bladeMode: boolean
  setBladeMode: Dispatch<SetStateAction<boolean>>
  backToSource: () => void
  seekTo: (t: number) => void
}

/** Source-document edits: the project-mode guard, blade/split, and highlight suggestion actions with Toast Undo. */
export function useStudioSourceEdits({
  videoPath,
  videoRef,
  mode,
  modeRef,
  dispatchMode,
  dispatch,
  apply,
  toast,
  projectRef,
  projectId,
  mountedRef,
  previewRef,
  currentTime,
  shownClips,
  activeClipId,
  setActiveClipId,
  setSelProjId,
  bladeMode,
  setBladeMode,
  backToSource,
  seekTo
}: StudioSourceEditsOptions) {
  const currentProjectId = useRef(projectId)
  currentProjectId.current = projectId
  /** Project-mode guard: ignore source-document editing actions (including Toast Undo/Create Project) and show a notice. */
  const guarded = useCallback(
    <A extends unknown[]>(cmd: Command | SourceEditCommand, fn: (...a: A) => void) =>
      (...a: A): void => {
        if (!mountedRef.current || currentProjectId.current !== projectId) return
        if (guardCommand(modeRef.current.mode, cmd) === 'blocked') {
          toast({ message: i18n.studio.toast.sourceOnlyEdit })
          return
        }
        fn(...a)
      },
    [toast, projectId, mountedRef]
  )

  /** Split (Ctrl+Q or track-head scissors in project mode): the playhead must be within the current clip, with a ±0.5-second boundary. */
  const splitProjectAtPlayhead = useCallback(() => {
    const item = previewRef.current.item
    const t = videoRef.current?.currentTime ?? currentTime
    if (mode.mode !== 'project' || !item || t <= item.start + 0.5 || t >= item.end - 0.5) {
      toast({ message: i18n.studio.toast.splitHint })
      return
    }
    const next = splitItem(projectRef.current, item.id, t)
    if (next === projectRef.current) {
      toast({ message: i18n.studio.toast.splitHint })
      return
    }
    apply(next)
    const at = next.items.findIndex((i) => i.id === item.id)
    const second = at >= 0 ? next.items[at + 1] : undefined
    if (second) {
      setSelProjId(second.id)
      dispatchMode({ type: 'playItem', item: second })
    }
  }, [mode.mode, currentTime, apply, toast])

  /** Blade mode (transport button or B): return to source at the current frame before enabling in project preview; append split clips to the project. */
  const toggleBlade = useCallback(() => {
    const wasProject = modeRef.current.mode === 'project'
    backToSource()
    setBladeMode((enabled) => wasProject || !enabled)
  }, [backToSource])

  /** Ctrl+Q toggles blade mode in source view and splits at the playhead in project preview. */
  const handleQuickOrSplit = useCallback(() => {
    if (modeRef.current.mode === 'project') splitProjectAtPlayhead()
    else toggleBlade()
  }, [splitProjectAtPlayhead, toggleBlade])

  const createBladeClip = useCallback((start: number, end: number): void => {
    const clip: Clip = { id: `c_${crypto.randomUUID()}`, start, end, origin: 'manual', event_ids: [], status: 'accepted' }
    const res = acceptToProject(clip, videoPath, projectRef.current)
    if (res.added.length === 0) return
    dispatch({ type: 'addClip', clip })
    apply(addItems(projectRef.current, res.added))
    toast({
      message: i18n.studio.toast.addedProject.replace('{sec}', String(Math.round(end - start))),
      action: {
        label: i18n.studio.toast.undo,
        run: guarded('editClips', () => {
          apply(res.undo(projectRef.current))
          dispatch({ type: 'removeClip', id: clip.id })
        })
      }
    })
  }, [videoPath, apply, toast, guarded])

  useEffect(() => {
    if (mode.mode !== 'source') setBladeMode(false)
  }, [mode.mode])
  /** Blade mode works only in source view; this also applies to the render before the effect clears the state. */
  const bladeActive = bladeMode && mode.mode === 'source'

  /** After handling the current suggestion, move the active card to the next one (using the pre-update list). */
  const advanceActive = useCallback(
    (fromId: string) => {
      setActiveClipId(nextSuggestion(shownClips, fromId, 1))
    },
    [shownClips]
  )

  /** Preview a clip: leave project mode and jump to its start (seekTo returns to source and applies the time after any source switch). */
  const previewClip = useCallback(
    (clip: Clip) => {
      seekTo(Math.max(0, clip.start))
    },
    [seekTo]
  )

  /** Add a suggestion (card/Enter): add it to the project and mark it added; Toast Undo removes the project clip and returns the card to suggested. */
  const acceptClip = useCallback(
    (clip: Clip) => {
      const plan = planAccept(clip, videoPath, projectRef.current)
      if (plan.notice === 'added') apply(plan.project)
      dispatch({ type: 'acceptClip', id: clip.id })
      if (plan.undo) {
        const undo = plan.undo
        toast({
          message: i18n.studio.toast.addedProject.replace(
            '{sec}',
            String(Math.round(Math.max(0, clip.end - clip.start)))
          ),
          action: {
            label: i18n.studio.toast.undo,
            run: guarded('editClips', () => {
              apply(undo.project(projectRef.current))
              dispatch({ type: undo.clipStatus === 'suggested' ? 'restoreClip' : 'acceptClip', id: clip.id })
            })
          }
        })
      } else {
        toast({ message: i18n.studio.toast.alreadyInProject })
      }
      advanceActive(clip.id)
    },
    [videoPath, apply, toast, advanceActive, guarded]
  )

  /** Skip a suggestion (card/Delete): mark it skipped; Toast Undo returns it to suggested. */
  const skipClip = useCallback(
    (clip: Clip) => {
      dispatch({ type: 'skipClip', id: clip.id })
      toast({
        message: i18n.studio.toast.skipped,
        action: { label: i18n.studio.toast.undo, run: guarded('editClips', () => dispatch({ type: 'restoreClip', id: clip.id })) }
      })
      advanceActive(clip.id)
    },
    [toast, advanceActive, guarded]
  )

  /** Unskip and return to suggested without showing a Toast. */
  const restoreClip = useCallback((clip: Clip) => {
    dispatch({ type: 'restoreClip', id: clip.id })
  }, [])

  /** Remove from the project: AI clips return to suggested and manual clips are removed from the list; Toast Undo reverses both changes. */
  const removeFromProject = useCallback(
    (clip: Clip) => {
      const ids = findItemsForClip(clip, videoPath, projectRef.current)
      const items = projectRef.current.items.filter((i) => ids.includes(i.id))
      if (items.length > 0) apply(removeProjectItems(projectRef.current, ids))
      const manual = clip.origin === 'manual'
      dispatch(manual ? { type: 'removeClip', id: clip.id } : { type: 'restoreClip', id: clip.id })
      toast({
        message: i18n.studio.toast.removedFromProject,
        action: {
          label: i18n.studio.toast.undo,
          run: guarded('editClips', () => {
            if (items.length > 0) apply(addItems(projectRef.current, items))
            dispatch(manual ? { type: 'addClip', clip } : { type: 'acceptClip', id: clip.id })
          })
        }
      })
    },
    [videoPath, apply, toast, guarded]
  )

  /** Add all (Ctrl+E or footer): use idempotent planAddAll so repeated calls do not duplicate clips; show one Toast Undo action. */
  const addAllSuggestions = useCallback(() => {
    const suggested = shownClips.filter(isSuggested)
    if (suggested.length === 0) return
    const plan = planAddAll(suggested, videoPath, projectRef.current)
    dispatch({ type: 'setClipStatuses', ids: suggested.map((c) => c.id), status: 'accepted' })
    if (plan.addedIds.length === 0) return
    apply(plan.project)
    const secs = Math.round(suggested.reduce((sum, c) => sum + Math.max(0, c.end - c.start), 0))
    toast({
      message: i18n.studio.toast.addedProject.replace('{sec}', String(secs)),
      action: {
        label: i18n.studio.toast.undo,
        run: guarded('editClips', () => {
          apply(removeProjectItems(projectRef.current, plan.addedIds))
          dispatch({ type: 'setClipStatuses', ids: suggested.map((c) => c.id), status: 'suggested' })
        })
      }
    })
  }, [shownClips, videoPath, apply, toast, guarded])

  /** Add suggestion (Enter): handle only the currently active suggestion. */
  const handleAcceptSuggestion = useCallback(() => {
    const clip = shownClips.find((c) => c.id === activeClipId)
    if (clip && isSuggested(clip)) acceptClip(clip)
  }, [shownClips, activeClipId, acceptClip])

  /** Skip suggestion (Delete): handle only the currently active suggestion. */
  const handleSkipSuggestion = useCallback(() => {
    const clip = shownClips.find((c) => c.id === activeClipId)
    if (clip && isSuggested(clip)) skipClip(clip)
  }, [shownClips, activeClipId, skipClip])

  return {
    guarded,
    splitProjectAtPlayhead,
    toggleBlade,
    handleQuickOrSplit,
    createBladeClip,
    bladeActive,
    previewClip,
    acceptClip,
    skipClip,
    restoreClip,
    removeFromProject,
    addAllSuggestions,
    handleAcceptSuggestion,
    handleSkipSuggestion
  }
}
