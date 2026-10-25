import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type RefObject } from 'react'
import type { CacheDoc } from '../../shared/types'
import type { ViewerState } from '../viewer/state'
import type { AutosaveController } from '../editor/useAutosave'
import type { Project, ProjectItem } from '../editor/project'
import { nextAfter, nextPlayableItem } from '../editor/sequence'
import { tr } from '../../shared/locale'
import { i18n } from '../i18n'
import type { useToast } from '../shell/ToastHost'
import type { createExportController } from './exportController'
import type { ModeAction } from './mode'
import { onVideoError, routeTimeUpdate } from './seekPlan'
import { normPath, type ProjectPlaybackRequest } from './studioScreenModel'
import type { StudioSourcePlayback } from './useStudioSourcePlayback'

interface StudioPlaybackOptions {
  source: StudioSourcePlayback
  videoRef: RefObject<HTMLVideoElement>
  videoPath: string
  project: Project
  projectRef: MutableRefObject<Project>
  previewRef: MutableRefObject<{ item: ProjectItem | null }>
  previewItem: ProjectItem | null
  missingItemIds: ReadonlySet<string>
  isPlaying: boolean
  loaded: boolean
  playbackRequest?: ProjectPlaybackRequest
  onPlaybackRequestConsumed?: () => void
  onOpenVideo: (path: string, request?: ProjectPlaybackRequest) => void
  exportCtl: ReturnType<typeof createExportController>
  toast: ReturnType<typeof useToast>
  stateRef: MutableRefObject<ViewerState>
  cacheSaver: MutableRefObject<AutosaveController<CacheDoc> | null>
  removalPending: MutableRefObject<boolean>
  switchingSourceRef: MutableRefObject<boolean>
  dispatchMode: Dispatch<ModeAction>
  setSelProjId: (id: string | null) => void
  setCurrentTime: (t: number) => void
  setPreviewTime: (t: number) => void
  setIsPlaying: (playing: boolean) => void
  setVideoMissing: (missing: boolean) => void
}

/** Project preview: source switching, sequential clip playback, and the <video> event handlers. */
export function useStudioPlayback({
  source,
  videoRef,
  videoPath,
  project,
  projectRef,
  previewRef,
  previewItem,
  missingItemIds,
  isPlaying,
  loaded,
  playbackRequest,
  onPlaybackRequestConsumed,
  onOpenVideo,
  exportCtl,
  toast,
  stateRef,
  cacheSaver,
  removalPending,
  switchingSourceRef,
  dispatchMode,
  setSelProjId,
  setCurrentTime,
  setPreviewTime,
  setIsPlaying,
  setVideoMissing
}: StudioPlaybackOptions) {
  const {
    hoverPreviewRef,
    previewRestoreRef,
    speedRef,
    currentTimeRef,
    loadedSrcRef,
    pendingSeekRef,
    sourceSrcRef,
    videoSrc,
    videoSrcRef,
    requestSeek
  } = source

  const missingRef = useRef(missingItemIds)
  missingRef.current = missingItemIds
  /** Clip already advanced once (prevents timeupdate, frame callbacks, and ended from advancing the same clip twice). */
  const advancedForRef = useRef<string | null>(null)

  /** Same-day selection and cross-source projects share saving and export protection, then App remounts the studio. */
  const openSource = useCallback((path: string, request?: ProjectPlaybackRequest): void => {
    if (removalPending.current || switchingSourceRef.current || normPath(path) === normPath(videoPath)) return
    if (exportCtl.getState().phase === 'running') {
      videoRef.current?.pause()
      toast({ message: i18n.export.backBlocked })
      return
    }
    if (stateRef.current.dirty) {
      try {
        if (window.api.cache.saveSync(stateRef.current.doc) === false) throw new Error(tr('來源儲存失敗'))
        cacheSaver.current!.cancelPending()
      } catch {
        videoRef.current?.pause()
        toast({ message: i18n.studio.toast.sourceSaveFailed })
        return
      }
    } else cacheSaver.current!.flushSync()
    switchingSourceRef.current = true
    videoRef.current?.pause()
    loadedSrcRef.current = null
    onOpenVideo(path, request)
  }, [videoPath, exportCtl, toast, onOpenVideo])

  /** Play directly within the same source; for another source, save synchronously before opening the requested clip. */
  const playProjectItem = useCallback((item: ProjectItem): void => {
    if (switchingSourceRef.current) return
    if (missingRef.current.has(item.id)) {
      toast({ message: i18n.studio.track.missingToast })
      return
    }
    if (normPath(item.source) !== normPath(videoPath)) {
      openSource(item.source, { playItemId: item.id, speed: speedRef.current })
      return
    }
    setSelProjId(item.id)
    if (previewRef.current.item?.id === item.id) {
      advancedForRef.current = null
      currentTimeRef.current = item.start
      setCurrentTime(item.start)
      setPreviewTime(item.start)
      requestSeek(item.start, sourceSrcRef.current, true)
    } else dispatchMode({ type: 'playItem', item })
  }, [videoPath, toast, openSource, requestSeek])

  const consumedRequest = useRef(false)
  useEffect(() => {
    if (!loaded || !playbackRequest || consumedRequest.current) return
    const item = project.items.find((i) => i.id === playbackRequest.playItemId)
    if (!item) return
    consumedRequest.current = true
    playProjectItem(item)
    onPlaybackRequestConsumed?.()
  }, [loaded, playbackRequest, project.items, playProjectItem, onPlaybackRequestConsumed])

  /** Move to the next clip after the current item, skipping clips with missing sources; pause if all are missing or there is no next clip (show a Toast for missing sources). */
  const advanceFrom = useCallback(
    (item: ProjectItem): void => {
      if (advancedForRef.current === item.id) return
      advancedForRef.current = item.id
      const r = nextPlayableItem(projectRef.current, item.id, missingRef.current)
      if (r.kind === 'item') {
        playProjectItem(r.item)
        return
      }
      videoRef.current?.pause()
      if (r.kind === 'allMissing') toast({ message: i18n.studio.track.restMissingToast })
    },
    [toast, playProjectItem]
  )

  /** When playback time t reaches the clip end, switch to the next clip (possibly in another video). */
  const advanceIfEnded = useCallback(
    (item: ProjectItem, t: number): void => {
      const step = nextAfter(projectRef.current, item.id, t, missingRef.current)
      if (step.kind === 'continue') return
      advanceFrom(item)
    },
    [advanceFrom]
  )

  const handlePlayingChange = useCallback((playing: boolean): void => {
    if (playing && !switchingSourceRef.current) advancedForRef.current = null // User resumed playback; allow pausing or advancing again at the clip end.
    setIsPlaying(playing)
  }, [])

  /** Handle the actual <video> end so playback can continue when a clip extends past the video duration. */
  const handleVideoEnded = useCallback((): void => {
    if (hoverPreviewRef.current) return
    const item = previewRef.current.item
    if (item && loadedSrcRef.current === videoSrcRef.current) advanceFrom(item)
  }, [advanceFrom])

  /** On load failure, invalidate pending seeks and the loaded marker, and clear the playing flag. */
  const handleVideoError = useCallback((): void => {
    const r = onVideoError({ loadedSrc: loadedSrcRef.current, pending: pendingSeekRef.current })
    loadedSrcRef.current = r.loadedSrc
    pendingSeekRef.current = r.pending
    setIsPlaying(r.playing)
    if (previewRef.current.item) toast({ message: i18n.studio.track.missingToast })
    // A source-mode video load failure means the video is missing or unplayable; show a notice with Relink/Back to Library actions.
    else setVideoMissing(true)
  }, [toast])

  // Project preview keeps the source playhead in sync and advances through clips; ignore stale events from the old video while switching sources.
  const handleTimeUpdate = useCallback((t: number) => {
    if (hoverPreviewRef.current || switchingSourceRef.current) return
    const item = previewRef.current.item
    const route = routeTimeUpdate({
      previewSrc: item ? videoSrcRef.current : null,
      sourceSrc: sourceSrcRef.current,
      loadedSrc: loadedSrcRef.current,
      pending: pendingSeekRef.current !== null
    })
    if (route === 'ignore') return
    currentTimeRef.current = t
    setCurrentTime(t)
    if (route === 'source') return
    setPreviewTime(t)
    if (!item) return
    advanceIfEnded(item, t)
  }, [advanceIfEnded])

  // On entering or switching preview clips, load the video, seek to the clip start, and play (spec §3.5).
  useEffect(() => {
    if (!previewItem) return
    advancedForRef.current = null
    const restore = previewRestoreRef.current
    previewRestoreRef.current = null
    const start = restore?.id === previewItem.id ? restore.time : Math.max(0, previewItem.start)
    currentTimeRef.current = start
    setCurrentTime(start)
    setPreviewTime(start)
    requestSeek(start, videoSrc, restore?.id === previewItem.id ? restore.playing : true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewItem?.id, previewItem?.start])

  // Check clip ends: timeupdate fires about every 250 ms; a frame callback (or 100 ms timer fallback) supplements it.
  // Schedule only during playback and compare one number each time, with negligible CPU cost.
  useEffect(() => {
    const el = videoRef.current
    const item = previewItem
    if (!el || !item || !isPlaying) return
    const check = (): void => {
      if (loadedSrcRef.current !== videoSrcRef.current || pendingSeekRef.current) return
      if (el.currentTime >= item.end) advanceFrom(item)
    }
    type Rvfc = HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number
      cancelVideoFrameCallback?: (id: number) => void
    }
    const v = el as Rvfc
    if (typeof v.requestVideoFrameCallback === 'function') {
      let id = 0
      let stopped = false
      const loop = (): void => {
        if (stopped) return
        check()
        id = v.requestVideoFrameCallback!(loop)
      }
      id = v.requestVideoFrameCallback(loop)
      return () => {
        stopped = true
        v.cancelVideoFrameCallback?.(id)
      }
    }
    const timer = window.setInterval(check, 100)
    return () => window.clearInterval(timer)
  }, [previewItem, advanceFrom, isPlaying])

  return {
    openSource,
    playProjectItem,
    handlePlayingChange,
    handleVideoEnded,
    handleVideoError,
    handleTimeUpdate
  }
}
