import type { MutableRefObject, RefObject } from 'react'
import type { CacheDoc } from '../../shared/types'
import type { LibraryEntry } from '../../main/library'
import type { ViewerState } from '../viewer/state'
import type { AutosaveController } from '../editor/useAutosave'
import { i18n } from '../i18n'
import type { useToast } from '../shell/ToastHost'
import type { createExportController } from './exportController'
import { baseName, normPath } from './studioScreenModel'

interface StudioVideoRemovalOptions {
  videoPath: string
  videoRef: RefObject<HTMLVideoElement>
  exportCtl: ReturnType<typeof createExportController>
  toast: ReturnType<typeof useToast>
  onVideoRemoved?: (path: string) => void
  stateRef: MutableRefObject<ViewerState>
  cacheSaver: MutableRefObject<AutosaveController<CacheDoc> | null>
  mountedRef: MutableRefObject<boolean>
  switchingSourceRef: MutableRefObject<boolean>
  loadedSrcRef: MutableRefObject<string | null>
  pendingSeekRef: MutableRefObject<{ t: number; play: boolean } | null>
  removalPending: MutableRefObject<boolean>
  removalInFlight: MutableRefObject<boolean>
  setRemoveChoice: (path: string | null) => void
  setRemovingVideo: (removing: boolean) => void
}

/** Remove the current or a same-day video from the library, optionally deleting the source file. */
export function useStudioVideoRemoval({
  videoPath,
  videoRef,
  exportCtl,
  toast,
  onVideoRemoved,
  stateRef,
  cacheSaver,
  mountedRef,
  switchingSourceRef,
  loadedSrcRef,
  pendingSeekRef,
  removalPending,
  removalInFlight,
  setRemoveChoice,
  setRemovingVideo
}: StudioVideoRemovalOptions): {
  removeVideo: (path: string, deleteSource?: boolean) => Promise<void>
  requestRemoveVideo: (path: string) => Promise<void>
} {
  const removeVideo = async (path: string, deleteSource?: boolean): Promise<void> => {
    if (!mountedRef.current || removalInFlight.current || exportCtl.getState().phase === 'running') return
    removalInFlight.current = true
    setRemoveChoice(null)
    setRemovingVideo(true)
    const current = normPath(path) === normPath(videoPath)
    const video = current && deleteSource !== false ? videoRef.current : null
    const playback = video ? { src: video.getAttribute('src'), t: video.currentTime, play: !video.paused } : null
    if (current) {
      videoRef.current?.pause()
      cacheSaver.current!.setHeld(true)
    }
    try {
      if (current && deleteSource === false && stateRef.current.dirty) {
        // Keeping the source also keeps its edits; stop removal if they cannot be saved.
        try {
          if (window.api.cache.saveSync(stateRef.current.doc) === false) throw new Error('Source save failed')
          cacheSaver.current!.cancelPending()
        } catch {
          toast({ message: i18n.studio.toast.sourceSaveFailed })
          return
        }
      }
      if (video) {
        // Pausing retains the Windows file handle; unload the media before deleting its source.
        loadedSrcRef.current = null
        pendingSeekRef.current = null
        video.removeAttribute('src')
        video.load()
      }
      if (deleteSource === undefined) await window.api.library.remove(path)
      else await window.api.library.remove(path, { deleteSource })
      // Only discard pending edits when the source file itself was deleted.
      if (current && deleteSource !== false) cacheSaver.current!.setEnabled(false)
      // Stay in the studio: the owner clears the removed current video and the studio landing opens the next one.
      onVideoRemoved?.(path)
    } catch {
      if (mountedRef.current && video && playback?.src) {
        pendingSeekRef.current = { t: playback.t, play: playback.play }
        video.src = playback.src
        video.load()
      }
      if (mountedRef.current) toast({ message: i18n.library.card.removeFailed })
    } finally {
      if (current) cacheSaver.current!.setHeld(false)
      removalPending.current = false
      removalInFlight.current = false
      if (mountedRef.current) setRemovingVideo(false)
    }
  }

  const requestRemoveVideo = async (path: string): Promise<void> => {
    if (removalPending.current || switchingSourceRef.current || exportCtl.getState().phase === 'running') return
    removalPending.current = true
    setRemovingVideo(true)
    try {
      const entries: LibraryEntry[] = await window.api.library.getEntries()
      if (!mountedRef.current) return
      const entry = entries.find((entry) => normPath(entry.path) === normPath(path))
      if (!entry) throw new Error('Video is no longer in the library')
      const t = i18n.library.card
      if (entry.source === 'recording') {
        if (window.confirm(t.removeSourceConfirm.replace('{name}', baseName(path)))) {
          await removeVideo(path)
          return
        }
        removalPending.current = false
      } else {
        setRemoveChoice(path)
      }
    } catch {
      removalPending.current = false
      if (mountedRef.current) toast({ message: i18n.library.card.removeFailed })
    }
    if (mountedRef.current) setRemovingVideo(false)
  }

  return { removeVideo, requestRemoveVideo }
}
