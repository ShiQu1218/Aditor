import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { LibraryEntry } from '../../main/library'
import type { CacheDoc } from '../../shared/types'
import { queueItemState, summarizeQueue, type QueuePayload } from '../../shared/queueState'
import { viewerReducer, type ViewerAction, type ViewerState } from '../viewer/state'
import { AutosaveController } from '../editor/useAutosave'
import { checkSmooth, type PlayabilityResult } from '../media/playability'
import { longFixtureRequested } from '../dev/fixture'
import { i18n } from '../i18n'
import type { useToast } from '../shell/ToastHost'
import type { createExportController } from './exportController'
import { loadStudioDoc, type LoadOutcome } from './studioLoader'
import { normPath } from './studioScreenModel'

interface StudioDocumentOptions {
  videoPath: string
  reloadKey: number
  preloadedDoc?: CacheDoc
  allowUnanalyzed: boolean
  loaded: boolean
  state: ViewerState
  stateRef: MutableRefObject<ViewerState>
  dispatch: Dispatch<ViewerAction>
  exportCtl: ReturnType<typeof createExportController>
  toast: ReturnType<typeof useToast>
  onRegisterLeaveGuard?: (guard: () => boolean) => () => void
  setBlocked: (blocked: boolean) => void
  setLoadError: (error: { code?: string | number; message: string } | null) => void
  setLoaded: (loaded: boolean) => void
  setAnalysisGen: Dispatch<SetStateAction<number>>
  setPlayability: (playability: PlayabilityResult) => void
  setProxyPath: (path: string | null) => void
  setProxyState: (state: 'none' | 'available' | 'generating') => void
}

/** Source document lifecycle: loading, debounced cache saving, the leave guard, and refresh after queued analysis. */
export function useStudioDocument({
  videoPath,
  reloadKey,
  preloadedDoc,
  allowUnanalyzed,
  loaded,
  state,
  stateRef,
  dispatch,
  exportCtl,
  toast,
  onRegisterLeaveGuard,
  setBlocked,
  setLoadError,
  setLoaded,
  setAnalysisGen,
  setPlayability,
  setProxyPath,
  setProxyState
}: StudioDocumentOptions): { cacheSaver: MutableRefObject<AutosaveController<CacheDoc> | null>; canLeaveStudio: () => boolean; queued: boolean } {
  const [queued, setQueued] = useState(false)
  const failedAnalysisPath = useRef<string | null>(null)
  /* ---------------- Loading (check entry status → cache:load → analyze if needed; see studioLoader) ---------------- */

  useEffect(() => {
    if (preloadedDoc) return
    const retryAnalysis = failedAnalysisPath.current === videoPath
    failedAnalysisPath.current = null
    let cancelled = false
    let offQueued: (() => void) | undefined
    setQueued(false)
    setBlocked(false)
    setLoadError(null)
    const load = async (): Promise<void> => {
      if (longFixtureRequested()) {
        const { buildLongDoc } = await import('../dev/longFixture')
        if (!cancelled) {
          dispatch({ type: 'analysisResult', doc: buildLongDoc(videoPath) })
          setAnalysisGen((g) => g + 1)
          setLoaded(true)
        }
        return
      }
      const api = window.api
      const outcome = await loadStudioDoc(videoPath, {
        getStatus: async (p) => {
          const entries: { path: string; status: string }[] | undefined = await api?.library?.getEntries?.()
          return entries?.find((e) => normPath(e.path) === normPath(p))?.status ?? null
        },
        cacheLoad: async (p) => ((await api?.cache?.loadByVideo?.(p)) as CacheDoc | null) ?? null,
        analyze: async (args) => ((await api?.engine?.analyze?.(args)) as CacheDoc | null) ?? null,
        probe: async (p) => (await api?.engine?.probe?.(p)) ?? null
      }, allowUnanalyzed, retryAnalysis)
      if (cancelled) return
      if (outcome.kind === 'queued') {
        setQueued(true)
        let refreshing = false
        let refreshPending = false
        let finished = false
        const refresh = async (): Promise<void> => {
          if (cancelled || finished) return
          if (refreshing) {
            refreshPending = true
            return
          }
          refreshPending = false
          refreshing = true
          try {
            const queue: QueuePayload = await api.queue.getState()
            const entries: LibraryEntry[] = await api.library.getEntries()
            if (cancelled) return
            const entry = entries.find((e) => normPath(e.path) === normPath(videoPath))
            const idle = queueItemState(summarizeQueue(queue, Date.now()), videoPath) === 'idle'
            if (entry?.status === 'error') {
              failedAnalysisPath.current = videoPath
              finished = true
              offQueued?.()
              await applyOutcome({ kind: 'error', message: entry.error ?? i18n.studio.toast.analysisRefreshFailed, code: entry.errorCode })
            } else if (entry?.status === 'done') {
              const doc: CacheDoc | null = await api.cache.loadByVideo(videoPath)
              if (cancelled) return
              if (doc?.analysis.status !== 'done') {
                // Nothing else will update this entry once its job is gone, so offer Retry instead of waiting forever.
                if (!idle || refreshPending) return
                failedAnalysisPath.current = videoPath
                finished = true
                offQueued?.()
                await applyOutcome({ kind: 'error', message: i18n.studio.toast.analysisRefreshFailed })
                return
              }
              finished = true
              offQueued?.()
              await applyOutcome({ kind: 'ready', doc, from: 'cache' })
            } else if (idle) {
              finished = true
              offQueued?.()
              await applyOutcome({ kind: 'blocked' })
            }
          } catch (err) {
            finished = true
            offQueued?.()
            await applyOutcome({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
          } finally {
            refreshing = false
            if (refreshPending) void refresh()
          }
        }
        offQueued = api.library.onUpdated(() => { void refresh() })
        void refresh()
        return
      }
      await applyOutcome(outcome)
    }
    const applyOutcome = async (outcome: LoadOutcome): Promise<void> => {
      if (cancelled) return
      if (outcome.kind === 'queued') return
      setQueued(false)
      if (outcome.kind === 'blocked') {
        setBlocked(true)
        return
      }
      if (outcome.kind === 'error') {
        console.error('Failed to load studio doc:', outcome.message)
        setLoadError({ code: outcome.code, message: outcome.message })
        return
      }
      dispatch({ type: 'analysisResult', doc: outcome.doc })
      setAnalysisGen((g) => g + 1)
      setLoaded(true)
      void checkSmooth(outcome.doc.video).then((pl) => {
        if (!cancelled) setPlayability(pl)
      })
      if (window.api?.proxy?.get) {
        try {
          const pp: string | null = await window.api.proxy.get(videoPath)
          if (!cancelled && pp) {
            setProxyPath(pp)
            setProxyState('available')
          }
        } catch (err) {
          console.error('Failed to get proxy:', err)
        }
      }
    }
    void load()
    return () => {
      cancelled = true
      offQueued?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoPath, reloadKey])

  // Debounce dirty-state writes to the cache by 1 second. Leaving the studio (unmount), closing the window (beforeunload), and main's flushRequest
  // synchronously write pending edits (I4), so the final second of work is not lost.
  const cacheSaver = useRef<AutosaveController<CacheDoc> | null>(null)
  if (!cacheSaver.current) {
    cacheSaver.current = new AutosaveController<CacheDoc>({
      delayMs: 1000,
      save: (doc) => window.api?.cache?.save?.(doc),
      saveSync: (doc) => window.api?.cache?.saveSync?.(doc),
      onError: () => toast({ message: i18n.studio.toast.sourceSaveFailed })
    })
  }
  useEffect(() => {
    const saver = cacheSaver.current!
    const flush = (): boolean => saver.flushSync()
    const beforeUnload = (event: BeforeUnloadEvent): void => {
      if (!flush()) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', beforeUnload)
    const offRequest = window.api?.projects?.onFlushRequest?.(flush)
    return () => {
      window.removeEventListener('beforeunload', beforeUnload)
      offRequest?.()
      if (saver.flushSync()) saver.dispose()
    }
  }, [])
  useEffect(() => {
    if (!state.dirty) return
    cacheSaver.current!.update(state.doc)
  }, [state.dirty, state.doc])

  const canLeaveStudio = useCallback((): boolean => {
    if (exportCtl.getState().phase === 'running') {
      toast({ message: i18n.export.backBlocked })
      return false
    }
    if (stateRef.current.dirty && !cacheSaver.current!.flushSync()) return false
    return true
  }, [exportCtl, toast])

  useEffect(() => onRegisterLeaveGuard?.(canLeaveStudio), [canLeaveStudio, onRegisterLeaveGuard])

  // Allow editing before source analysis completes; when the queue finishes, update only the document and preserve playback and unsaved edits.
  useEffect(() => {
    if (!loaded || state.doc.analysis.status === 'done') return
    let cancelled = false
    let refreshing = false
    const refresh = async (): Promise<void> => {
      if (refreshing) return
      refreshing = true
      try {
        const entries = await window.api.library.getEntries()
        if (cancelled || !entries.some((e: { path: string; status: string }) => normPath(e.path) === normPath(videoPath) && e.status === 'done')) return
        const doc: CacheDoc | null = await window.api.cache.loadByVideo(videoPath)
        if (cancelled || doc?.analysis.status !== 'done') return
        const previous = stateRef.current
        const merged = viewerReducer(previous, { type: 'analysisResult', doc })
        cacheSaver.current!.cancelPending()
        if (previous.dirty || previous.clips.length || previous.doc.events.some((e) => e.source === 'manual')) {
          cacheSaver.current!.update(merged.doc)
        }
        dispatch({ type: 'analysisResult', doc })
        setAnalysisGen((g) => g + 1)
      } catch {
        if (!cancelled) toast({ message: i18n.studio.toast.analysisRefreshFailed })
      } finally {
        refreshing = false
      }
    }
    const off = window.api?.library?.onUpdated?.(() => { void refresh() })
    void refresh()
    return () => { cancelled = true; off?.() }
  }, [loaded, state.doc.analysis.status, videoPath, toast])

  return { cacheSaver, canLeaveStudio, queued }
}
