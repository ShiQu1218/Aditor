import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react'
import '../styles/studio.css'
import '../styles/projectTrack.css'
import { CacheDoc, Clip, EventType } from '../../shared/types'
import { formatTime, toCurrentTime } from '../../shared/time'
import { viewerReducer, ViewerState } from '../viewer/state'
import { leadInSeek, STUDIO_SETTINGS_DEFAULTS, subscribeStudioSettings, type StudioSettings } from './studioSettings'
import { nextEvent } from '../timeline/model'
import { TimelineCanvas, TimelineHandle } from '../timeline/TimelineCanvas'
import { useKeymap } from '../hooks/useShortcuts'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { useToast } from '../shell/ToastHost'
import { useOverlay } from '../shell/OverlayHost'
import { useProject } from '../editor/ProjectProvider'
import { importExternalVideos } from '../editor/externalVideos'
import { addItems, duplicateItem, moveItem, Project, ProjectItem, removeItem, splitItem, trimItem } from '../editor/project'
import { nextAfter, nextPlayableItem } from '../editor/sequence'
import { ExportDrawer } from './ExportDrawer'
import { createExportController } from './exportController'
import { windowExportApi } from './exportApi'
import { buildPlanBase, ExportPlanBase } from './exportPlanBase'
import { useEditorLock } from '../editor/useEditorLock'
import { checkSmooth, PlayabilityResult } from '../media/playability'
import { Command } from '../input/keymap'
import { drawerFixtureRequested, longFixtureRequested } from '../dev/fixture'
import { i18n, settingsI18n } from '../i18n'
import { AddEventDialog } from './AddEventDialog'
import { Aside } from './Aside'
import { AutoClipPopover } from './AutoClipPopover'
import {
  acceptToProject,
  applyAutoClip,
  clipAt,
  clipTitle,
  findItemsForClip,
  isSuggested,
  mergeSuggestions,
  nextSuggestion,
  planAccept,
  planAddAll,
  isSuggestionsPending,
  planSuggestions,
  removeProjectItems,
  withProjectStatus
} from './highlights'
import { HighlightsTab } from './HighlightsTab'
import { NoticeBar } from './NoticeBar'
import { PlayerStage } from './PlayerStage'
import { ProjectTrack } from './ProjectTrack'
import { StudioHeader } from './StudioHeader'
import { SameDayVideos } from './SameDayVideos'
import { StudioBlockedView, StudioLoadErrorView, StudioLoadingView } from './StudioStates'
import { TransportBar } from './TransportBar'
import { chipCounts, nearCount, toggleFilter, chipTypesFor } from './chips'
import { createMode, currentItem, reconcileMode, reduceMode } from './mode'
import { NoticeAction, proxyBusyNotice, studioNotice, StudioNotice } from './notices'
import { createAnnouncer } from './liveAnnouncer'
import { guardCommand, SourceEditCommand } from './modeGuard'
import { eventAriaLabel } from './reasons'
import { AutosaveController } from '../editor/useAutosave'
import { navReference, type NavAnchor } from './eventNav'
import { isAnyOverlayOpen, OverlayState, topOverlay } from './overlays'
import { fileUrl, onVideoError, planSeek, routeTimeUpdate } from './seekPlan'
import { loadStudioDoc } from './studioLoader'
import { tr } from '../../shared/locale'

export interface ProjectPlaybackRequest {
  playItemId: string
  speed: number
}

interface StudioScreenProps {
  videoPath: string
  onBack: () => void
  onOpenVideo: (path: string, request?: ProjectPlaybackRequest) => void
  playbackRequest?: ProjectPlaybackRequest
  onPlaybackRequestConsumed?: () => void
  /** Test seam: provide an already-loaded document directly (skip loading; used for the SSR smoke test). */
  preloadedDoc?: CacheDoc
}

const DEFAULT_FILTER = new Set<EventType>(['knock', 'assist_knock', 'assist_elim', 'elim', 'squad_wipe', 'kill', 'death', 'multikill', 'ace'])
const DEFAULT_PLAYABILITY: PlayabilityResult = { supported: true, smooth: true, powerEfficient: true }

function baseName(p: string): string {
  return p.split(/[/\\]/).pop() ?? p
}

/** Normalize a path when checking whether a clip belongs to the currently open video. */
function normPath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

function initialDoc(videoPath: string): CacheDoc {
  return {
    version: 1,
    video: {
      path: videoPath,
      size: 0,
      mtime: 0,
      duration: 100,
      width: 1920,
      height: 1080,
      codec: 'h264',
      start_time: 0
    },
    analysis: {
      status: 'done',
      progress_t: 0,
      engine_version: '0.1.0',
      templates_version: 'icons@1',
      h_scale: 1.0
    },
    events: [],
    spectating: [],
    clips: [],
    keyframes: [],
    cache_path: ''
  }
}

function initViewerState(init: { videoPath: string; doc?: CacheDoc }): ViewerState {
  return {
    doc: init.doc ?? initialDoc(init.videoPath),
    filter: new Set(DEFAULT_FILTER),
    clips: [],
    dirty: false
  }
}

/**
 * Studio (spec §3.2): player, transport bar, source timeline, project track, and sidebar.
 * Mode pill/context banner, status bar (engine errors and proxy suggestions), and counted event-filter chips.
 * Project track (Task 13): clip cards, drag reordering, handle trimming, track-head actions, and the new-project dialog.
 */
export function StudioScreen({ videoPath, onBack, onOpenVideo, playbackRequest, onPlaybackRequestConsumed, preloadedDoc }: StudioScreenProps): JSX.Element {
  const {
    project,
    apply,
    undo,
    redo,
    canUndo,
    canRedo,
    newProject,
    saveState,
    missingItemIds
  } = useProject()
  const toast = useToast()
  const overlay = useOverlay()

  /* ---------------- Export drawer (Task 15): the controller lives at the studio level, so export continues when the drawer is minimized to a badge. ---------------- */
  const exportCtl = useMemo(() => createExportController(windowExportApi, 'highlight'), [])
  const exportState = useSyncExternalStore(exportCtl.subscribe, exportCtl.getState, exportCtl.getState)
  const exporting = exportState.phase === 'running'
  useEditorLock(exporting)
  const [exportOpen, setExportOpen] = useState(false)
  const exportOpenRef = useRef(false)
  exportOpenRef.current = exportOpen
  const [exportBase, setExportBase] = useState<ExportPlanBase | null>(null)
  useEffect(() => () => exportCtl.dispose({ cancelIfRunning: true }), [exportCtl])

  const videoRef = useRef<HTMLVideoElement>(null)
  const tlRef = useRef<TimelineHandle>(null)
  const [state, dispatch] = useReducer(viewerReducer, { videoPath, doc: preloadedDoc }, initViewerState)
  const [mode, dispatchMode] = useReducer(reduceMode, videoPath, createMode)

  /** Source playhead (tracks the clip's source time during project preview). */
  const [currentTime, setCurrentTime] = useState(0)
  /** Video time during project preview (drives only project-track progress, splitting, and sequential playback). */
  const [previewTime, setPreviewTime] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [speed, setSpeed] = useState(playbackRequest?.speed ?? 1.0)
  const [asideOpen, setAsideOpen] = useState(true)
  const [addEventAt, setAddEventAt] = useState<number | null>(null)
  const [autoClipOpen, setAutoClipOpen] = useState(false)
  const [bladeMode, setBladeMode] = useState(false)
  const [sourceTrim, setSourceTrim] = useState<{ id: string; edge: 'start' | 'end'; t: number } | null>(null)
  const hoverPreviewRef = useRef<{ time: number; playing: boolean } | null>(null)
  const scrubSessionRef = useRef<{ item: ProjectItem | null; time: number; playing: boolean } | null>(null)
  const previewRestoreRef = useRef<{ id: string; time: number; playing: boolean } | null>(null)
  const [activeClipId, setActiveClipId] = useState<string | null>(null)
  /** Selected project-track clip (target of Alt+←/→, Ctrl+D, Delete, and Enter). */
  const [selProjId, setSelProjId] = useState<string | null>(null)
  /** Whether the new-project dialog is open (pauses the global keymap). */
  const [projDlgOpen, setProjDlgOpen] = useState(false)
  /** Settings snapshot (automatic suggestions, popover defaults, project-track collapse, event lead-in, and proxy suggestions); use DEFAULT_SETTINGS until loaded. */
  const [settings, setSettings] = useState<StudioSettings | null>(null)
  /** Use defaults until settings load (automatic suggestions still wait for settings). */
  const cfg = settings ?? STUDIO_SETTINGS_DEFAULTS

  const [reloadKey, setReloadKey] = useState(0)
  const [blocked, setBlocked] = useState(false)
  /** Whether analysis results have loaded (do not show a fake default document before then). */
  const [loaded, setLoaded] = useState(Boolean(preloadedDoc))
  /** Load failure: keep code and message separate (code for the status-bar copy, message for copying). */
  const [loadError, setLoadError] = useState<{ code?: string | number; message: string } | null>(null)
  const [proxyPct, setProxyPct] = useState<number | null>(null)
  const [playability, setPlayability] = useState<PlayabilityResult>(DEFAULT_PLAYABILITY)
  const [proxyPath, setProxyPath] = useState<string | null>(null)
  const [proxyState, setProxyState] = useState<'none' | 'available' | 'generating'>('none')
  const [proxyDismissed, setProxyDismissed] = useState(false)
  const [live, setLive] = useState('')

  const duration = state.doc.video?.duration || 100
  const displayedProject = useMemo(() => sourceTrim
    ? trimItem(project, sourceTrim.id, sourceTrim.edge, sourceTrim.t, duration) : project, [project, sourceTrim, duration])
  const previewItem = currentItem(mode, project)
  const sourceProjectItem = previewItem ?? displayedProject.items.find((item) => item.id === selProjId)
  const sourceRange = sourceProjectItem && normPath(sourceProjectItem.source) === normPath(videoPath)
    ? displayedProject.items.find((item) => item.id === sourceProjectItem.id) ?? null : null
  // Determine “added” from actual project content (deleting a project clip or creating a new project returns the card and track to suggested).
  const shownClips = useMemo(() => withProjectStatus(state.clips, videoPath, displayedProject), [state.clips, videoPath, displayedProject])
  const allowUnanalyzed = useRef(Boolean(playbackRequest)).current
  const switchingSourceRef = useRef(false)
  const importingRef = useRef(false)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  const stateRef = useRef(state)
  stateRef.current = state

  // Project-track collapse: 'auto' collapses when the window is ≤800px high; save manual changes to settings.
  const autoCollapse = useMediaQuery('(max-height: 800px)')
  const collapsePref = cfg.projectTrackCollapsed
  const projCollapsed = collapsePref === 'auto' ? autoCollapse : collapsePref

  // Read from timeupdate without recreating the callback on every frame.
  const previewRef = useRef<{ item: ProjectItem | null }>({ item: null })
  previewRef.current = { item: previewItem }

  // Latest project snapshot (Toast Undo runs after the trigger, so it must not capture a stale value).
  const projectRef = useRef(project)
  projectRef.current = project

  // Latest clip snapshot (suggestion merging runs after await and must not capture stale values).
  const clipsRef = useRef(state.clips)
  clipsRef.current = state.clips

  // Analysis generation (increment after each load or reanalysis): plan suggestions only once per generation.
  const [analysisGen, setAnalysisGen] = useState(preloadedDoc ? 1 : 0)
  const handledGen = useRef(0)
  /** Suggestion request sequence: discard older responses after the user applies the popover or starts a newer request. */
  const suggestSeq = useRef(0)

  /* ---------------- Loading (check entry status → cache:load → analyze if needed; see studioLoader) ---------------- */

  useEffect(() => {
    if (preloadedDoc) return
    let cancelled = false
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
      }, allowUnanalyzed)
      if (cancelled) return
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
      if (api?.proxy?.get) {
        try {
          const pp: string | null = await api.proxy.get(videoPath)
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
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoPath, reloadKey])

  // Debounce dirty-state writes to the cache by 1 second. Leaving the studio (unmount), closing the window (beforeunload), and main's flushRequest
  // synchronously write pending edits (I4), so the final second of work is not lost.
  const cacheSaver = useRef<AutosaveController<CacheDoc> | null>(null)
  if (!cacheSaver.current) {
    cacheSaver.current = new AutosaveController<CacheDoc>({
      delayMs: 1000,
      save: (doc) => void window.api?.cache?.save?.(doc),
      saveSync: (doc) => void window.api?.cache?.saveSync?.(doc)
    })
  }
  useEffect(() => {
    const saver = cacheSaver.current!
    const flush = (): void => saver.flushSync()
    window.addEventListener('beforeunload', flush)
    const offRequest = window.api?.projects?.onFlushRequest?.(flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      offRequest?.()
      saver.flushSync()
      saver.dispose()
    }
  }, [])
  useEffect(() => {
    if (!state.dirty) return
    cacheSaver.current!.update(state.doc)
  }, [state.dirty, state.doc])

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

  /* ---------------- Settings and automatic suggestions ---------------- */

  // Read settings and subscribe to settings:changed (lead-in/out, proxy suggestion, AI defaults, and project-track collapse apply without restart).
  useEffect(() => subscribeStudioSettings(window.api, setSettings), [])

  const changePreviewAudio = (previewVolume: number, previewMuted: boolean): void => {
    setSettings((current) => ({ ...(current ?? STUDIO_SETTINGS_DEFAULTS), previewVolume, previewMuted }))
    void (async () => {
      try {
        const result = await window.api.settings.set({ previewVolume, previewMuted })
        if (!result.persisted) toast({ message: settingsI18n.saveFailed })
      } catch {
        toast({ message: settingsI18n.saveFailed })
      }
    })()
  }

  // Suggestions after analysis (spec §3.2.6, §4.2): engine documents contain manual clips only, so
  // - on load, if there are no AI clips and the setting is enabled, place suggestions automatically;
  // - on reanalysis of a video with AI clips, rerun autoclip with default parameters and merge via mergeOnReanalyze
  //   (keep added clips as stale, discard old suggestions/skips, and add new suggestions).
  // Run once per analysis generation; do not call when the engine is unavailable.
  useEffect(() => {
    if (!settings || analysisGen === 0 || handledGen.current === analysisGen) return
    handledGen.current = analysisGen
    // The app.suggestionsPending document flag determines whether this is a reanalysis (main writes it afterward); on a fresh studio mount,
    // there are no clips in state to distinguish reanalysis from first load.
    const plan = planSuggestions({ doc: state.doc, clips: clipsRef.current, settings })
    if (plan.kind === 'none') {
      // Even when no suggestions can be made (for example, no events), clear the flag so every open is not treated as pending.
      if (isSuggestionsPending(state.doc) && state.doc.analysis?.status === 'done') {
        dispatch({ type: 'applySuggestions', clips: clipsRef.current })
      }
      return
    }
    const api = window.api
    if (!api?.engine?.autoclip) return
    const seq = ++suggestSeq.current
    const events = state.doc.events
    void (async () => {
      try {
        const res = await api.engine.autoclip({ events, params: plan.params, duration })
        if (seq !== suggestSeq.current) return // The user applied the popover or started a newer request in the meantime.
        const fresh: Clip[] = Array.isArray(res?.clips) ? res.clips : []
        if (plan.kind === 'place' && fresh.length === 0) return
        // After applying, clear the flag and save so the same reanalysis merges only once and later user skips are not overwritten.
        // Keep the flag when autoclip fails so it can retry on the next open.
        dispatch({ type: 'applySuggestions', clips: mergeSuggestions(plan.kind, clipsRef.current, fresh) })
      } catch (err) {
        console.error('Failed to place AI suggestions:', err)
      }
    })()
  }, [settings, state.doc, analysisGen, duration])

  // Ensure a card is active when the highlights tab opens (the first roving-tabindex stop).
  useEffect(() => {
    setActiveClipId((prev) =>
      prev && shownClips.some((c) => c.id === prev) ? prev : nextSuggestion(shownClips, null, 1)
    )
  }, [shownClips])

  // When the playhead enters a highlight's range, make that card active so the sidebar points at it;
  // react only to entering a new range so manual card selection outside highlights is left alone.
  const clipUnderPlayhead = useMemo(() => clipAt(shownClips, currentTime), [shownClips, currentTime])
  useEffect(() => {
    if (clipUnderPlayhead) setActiveClipId(clipUnderPlayhead)
  }, [clipUnderPlayhead])

  /* ---------------- Playback controls ---------------- */

  // Latest values for event handlers (avoid stale closures and rebuilding callbacks every frame).
  const modeRef = useRef(mode)
  modeRef.current = mode
  const speedRef = useRef(speed)
  speedRef.current = speed

  /** Project-mode guard: ignore source-document editing actions (including Toast Undo/Create Project) and show a notice. */
  const guarded = useCallback(
    <A extends unknown[]>(cmd: Command | SourceEditCommand, fn: (...a: A) => void) =>
      (...a: A): void => {
        if (guardCommand(modeRef.current.mode, cmd) === 'blocked') {
          toast({ message: i18n.studio.toast.sourceOnlyEdit })
          return
        }
        fn(...a)
      },
    [toast]
  )
  /** Current source playhead value. */
  const currentTimeRef = useRef(0)
  /** src for the currently loaded <video> (set after loadedmetadata and cleared when switching files). */
  const loadedSrcRef = useRef<string | null>(null)
  /** Seek to apply after the new src loads (never set currentTime on a <video> that is about to be replaced). */
  const pendingSeekRef = useRef<{ t: number; play: boolean } | null>(null)

  const sourceSrc = useMemo(() => fileUrl(proxyPath ?? videoPath), [proxyPath, videoPath])
  const videoSrc = sourceSrc
  const sourceSrcRef = useRef(sourceSrc)
  sourceSrcRef.current = sourceSrc
  const videoSrcRef = useRef(videoSrc)
  videoSrcRef.current = videoSrc

  /** Seek the <video> to t: apply immediately if the target file is loaded, or wait for loadedmetadata. */
  const requestSeek = useCallback((t: number, wantedSrc: string, play: boolean): void => {
    const el = videoRef.current
    if (el && planSeek({ loadedSrc: loadedSrcRef.current, wantedSrc }) === 'now') {
      pendingSeekRef.current = null
      el.currentTime = toCurrentTime(t, 0)
      if (play) void el.play().catch(() => {})
      return
    }
    pendingSeekRef.current = { t, play }
  }, [])

  const handleLoadedMetadata = useCallback((): void => {
    const el = videoRef.current
    if (!el) return
    loadedSrcRef.current = videoSrcRef.current
    el.playbackRate = speedRef.current // Reapply playback speed after each file switch.
    const p = pendingSeekRef.current
    if (p) {
      pendingSeekRef.current = null
      el.currentTime = toCurrentTime(p.t, 0)
      if (p.play) void el.play().catch(() => {})
    }
  }, [])

  // On file switch, invalidate the old loaded marker; when the proxy is ready, preserve source/project-preview position and playback state.
  const prevSrcRef = useRef(videoSrc)
  useEffect(() => {
    if (prevSrcRef.current === videoSrc) return
    prevSrcRef.current = videoSrc
    loadedSrcRef.current = null
    if (!pendingSeekRef.current) {
      pendingSeekRef.current = { t: currentTimeRef.current, play: isPlaying }
    }
  }, [videoSrc])

  /** Current source playhead time (use the saved time while switching files). */
  const sourcePlayTime = useCallback((): number => {
    const el = videoRef.current
    if (hoverPreviewRef.current) return hoverPreviewRef.current.time
    if (
      !el ||
      pendingSeekRef.current ||
      loadedSrcRef.current !== sourceSrcRef.current
    ) {
      return currentTimeRef.current
    }
    return el.currentTime
  }, [])

  // Throttle keyboard-driven playhead/zoom changes and announce them through polite aria-live.
  const announcerRef = useRef<ReturnType<typeof createAnnouncer> | null>(null)
  useEffect(() => {
    const a = createAnnouncer(setLive)
    announcerRef.current = a
    return () => a.dispose()
  }, [])
  const announce = useCallback((msg: string): void => announcerRef.current?.announce(msg), [])

  const togglePlay = useCallback(() => {
    const el = videoRef.current
    if (!el) return
    if (el.paused) void el.play().catch(() => {})
    else el.pause()
  }, [])

  const cycleSpeed = useCallback(() => {
    const speeds = [1.0, 0.5, 0.25, 2.0]
    setSpeed((prev) => {
      const next = speeds[(speeds.indexOf(prev) + 1) % speeds.length]
      if (videoRef.current) videoRef.current.playbackRate = next
      return next
    })
  }, [])

  /** For any source seek (timeline, event, highlight preview, or arrow keys), return to source mode first and apply the time after switching files. */
  const seekTo = useCallback(
    (t: number) => {
      const clamped = Math.max(0, t)
      if (modeRef.current.mode === 'project') dispatchMode({ type: 'seekSource' })
      requestSeek(clamped, sourceSrcRef.current, false)
      currentTimeRef.current = clamped
      setCurrentTime(clamped)
    },
    [requestSeek]
  )

  /** Pause before dragging; resume the original playback state on release, or restore the original project preview on cancel. */
  const startScrub = useCallback((): void => {
    const el = videoRef.current
    scrubSessionRef.current = { item: previewRef.current.item, time: el?.currentTime ?? 0, playing: !!el && !el.paused }
    el?.pause()
  }, [])
  const endScrub = useCallback((cancelled: boolean): void => {
    const session = scrubSessionRef.current
    scrubSessionRef.current = null
    if (!session) return
    if (cancelled && session.item && projectRef.current.items.some((item) => item.id === session.item!.id)) {
      if (modeRef.current.mode === 'project') {
        dispatchMode({ type: 'playItem', item: session.item })
        requestSeek(session.time, videoSrcRef.current, session.playing)
        return
      }
      previewRestoreRef.current = { id: session.item.id, time: session.time, playing: session.playing }
      dispatchMode({ type: 'playItem', item: session.item })
    } else requestSeek(currentTimeRef.current, sourceSrcRef.current, session.playing)
  }, [requestSeek])

  /** Blade hover changes only the preview frame; the source playhead and saved time stay in place. */
  const hoverSeek = useCallback((t: number | null): void => {
    const el = videoRef.current
    if (t === null) {
      const session = hoverPreviewRef.current
      hoverPreviewRef.current = null
      if (session) requestSeek(session.time, sourceSrcRef.current, session.playing)
      return
    }
    if (modeRef.current.mode !== 'source') return
    if (!hoverPreviewRef.current) {
      const time = sourcePlayTime()
      hoverPreviewRef.current = { time, playing: !!el && !el.paused }
      currentTimeRef.current = time
      setCurrentTime(time)
      el?.pause()
    }
    requestSeek(t, sourceSrcRef.current, false)
  }, [requestSeek, sourcePlayTime])

  /** Return to source (Esc or banner button) at the current clip's source time so editing can continue there. */
  const backToSource = useCallback(() => {
    if (modeRef.current.mode !== 'project') return
    dispatchMode({ type: 'backToSource' })
    videoRef.current?.pause()
    requestSeek(currentTimeRef.current, sourceSrcRef.current, false)
  }, [requestSeek])

  // If the previewed clip no longer exists (for example, Undo removed it), return to source mode.
  useEffect(() => {
    if (reconcileMode(mode, project) !== mode) backToSource()
  }, [mode, project, backToSource])

  const seekBy = useCallback(
    (delta: number) => {
      const target = Math.max(0, Math.min(duration, sourcePlayTime() + delta))
      seekTo(target)
      announce(i18n.studio.live.playhead.replace('{time}', formatTime(target)))
    },
    [duration, sourcePlayTime, seekTo, announce]
  )

  /** Event just reached with Ctrl+←/→ (when the playhead is at its lead-in, use the event time as the next navigation reference; see eventNav). */
  const navAnchorRef = useRef<NavAnchor | null>(null)
  const seekEvent = useCallback(
    (dir: 1 | -1) => {
      const ev = nextEvent(state.doc.events, navReference(currentTimeRef.current, navAnchorRef.current), dir, state.filter)
      if (!ev) return
      const target = leadInSeek(ev.t, cfg.before)
      seekTo(target)
      navAnchorRef.current = { eventT: ev.t, seekT: target }
      // Announce the event itself—type, time, and whether it counts (including the reason when it does not)—rather than only the playhead time.
      announce(eventAriaLabel(ev))
    },
    [state.doc.events, state.filter, seekTo, announce, cfg.before]
  )

  const handleSelectEvent = useCallback(
    (ev: { t: number }) => {
      seekTo(leadInSeek(ev.t, cfg.before))
    },
    [seekTo, cfg.before]
  )

  const missingRef = useRef(missingItemIds)
  missingRef.current = missingItemIds
  /** Clip already advanced once (prevents timeupdate, frame callbacks, and ended from advancing the same clip twice). */
  const advancedForRef = useRef<string | null>(null)

  /** Same-day selection and cross-source projects share saving and export protection, then App remounts the studio. */
  const openSource = useCallback((path: string, request?: ProjectPlaybackRequest): void => {
    if (switchingSourceRef.current || normPath(path) === normPath(videoPath)) return
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

  /* ---------------- Mode pill and context ---------------- */

  const previewIndex = previewItem ? project.items.findIndex((i) => i.id === previewItem.id) + 1 : 0
  const modeLabel = useMemo(() => {
    const m = i18n.studio.mode
    if (mode.mode === 'source' || !previewItem) return `${m.source} · ${baseName(videoPath)}`
    const item = m.item.replace('{i}', String(previewIndex)).replace('{n}', String(project.items.length))
    return `${m.project} · ${item} · ${formatTime(previewItem.start)}–${formatTime(previewItem.end)}`
  }, [mode.mode, previewItem, previewIndex, project.items.length, videoPath])

  /** Playback progress within the current clip (project-mode card progress bar). */
  const previewProgress = useMemo(() => {
    if (!previewItem) return 0
    const len = Math.max(1e-6, previewItem.end - previewItem.start)
    return Math.max(0, Math.min(1, (previewTime - previewItem.start) / len))
  }, [previewItem, previewTime])

  /** Clip label: use labels such as “N-kill highlight” when a matching clip exists in the current video; otherwise use the generic title. */
  const labelOf = useCallback(
    (item: ProjectItem): string => {
      if (normPath(item.source) === normPath(videoPath)) {
        const clip = state.clips.find(
          (c) => Math.abs(c.start - item.start) < 1e-3 && Math.abs(c.end - item.end) < 1e-3
        )
        if (clip) return clipTitle(clip, state.doc.events)
      }
      return i18n.studio.hl.genericTitle
    },
    [state.clips, state.doc.events, videoPath]
  )

  const spectatingNow = useMemo(
    () => state.doc.spectating.some((s) => currentTime >= s.start && currentTime <= s.end),
    [state.doc.spectating, currentTime]
  )
  const recentCounted = useMemo(() => nearCount(state.doc.events, currentTime), [state.doc.events, currentTime])

  /* ---------------- Status bar (engine errors and proxies) ---------------- */

  const [videoMissing, setVideoMissing] = useState(false)
  useEffect(() => setVideoMissing(false), [videoPath, reloadKey])
  const docAnalysis = state.doc.analysis
  const notice: StudioNotice | null = useMemo(() => {
    const base = studioNotice({
      analysis: 'done',
      videoMissing,
      playability,
      proxyState,
      proxySuggest: cfg.proxySuggest
    })
    if (proxyDismissed && base?.id === 'proxy-suggest') return null
    return base
  }, [playability, proxyState, proxyDismissed, cfg.proxySuggest, docAnalysis, videoMissing])

  const busyNotice: StudioNotice | null = useMemo(
    () => (proxyState === 'generating' ? proxyBusyNotice(proxyPct) : null),
    [proxyState, proxyPct]
  )
  const shownNotice = notice ?? busyNotice

  // Proxy generation progress pushed by main after parsing ffmpeg output.
  useEffect(() => {
    const off = window.api?.proxy?.onProgress?.((d: { videoPath: string; ratio: number }) => {
      if (normPath(d.videoPath) === normPath(videoPath)) setProxyPct(d.ratio)
    })
    return () => off?.()
  }, [videoPath])

  const handleGenerateProxy = useCallback(async (): Promise<void> => {
    setProxyState('generating')
    setProxyPct(null)
    try {
      const p: string | null = await window.api?.proxy?.generate?.(videoPath, duration)
      if (p) {
        setProxyPath(p)
        setProxyState('available')
      } else {
        setProxyState('none')
      }
    } catch (err) {
      console.error('Failed to generate proxy:', err)
      setProxyState('none')
    }
  }, [videoPath, duration])

  /** Return to the library; while export is running, stay in the studio and show a Toast instead. */
  const requestBack = useCallback((): void => {
    if (exportCtl.getState().phase === 'running') {
      toast({ message: i18n.export.backBlocked })
      return
    }
    onBack()
  }, [exportCtl, toast, onBack])

  const handleNoticeAction = useCallback(
    (a: NoticeAction): void => {
      if (a === 'resume') {
        setLoadError(null)
        setReloadKey((k) => k + 1)
      } else if (a === 'copyError') {
        void navigator.clipboard?.writeText(loadError?.message ?? '').catch(() => {})
        toast({ message: i18n.studio.toast.copied })
      } else if (a === 'generateProxy') {
        void handleGenerateProxy()
      } else if (a === 'later') {
        setProxyDismissed(true)
      } else if (a === 'back') {
        requestBack()
      } else if (a === 'relink') {
        // Relink returns to the library, where the user can remove the invalid entry and import the file again.
        toast({ message: i18n.studio.toast.relinkHint })
        requestBack()
      }
    },
    [loadError, handleGenerateProxy, toast, requestBack]
  )

  /* ---------------- Editing operations ---------------- */

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
    for (const c of suggested) dispatch({ type: 'acceptClip', id: c.id })
    if (plan.addedIds.length === 0) return
    apply(plan.project)
    const secs = Math.round(suggested.reduce((sum, c) => sum + Math.max(0, c.end - c.start), 0))
    toast({
      message: i18n.studio.toast.addedProject.replace('{sec}', String(secs)),
      action: {
        label: i18n.studio.toast.undo,
        run: guarded('editClips', () => {
          apply(removeProjectItems(projectRef.current, plan.addedIds))
          for (const c of suggested) dispatch({ type: 'restoreClip', id: c.id })
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

  const projectRefForExport = useRef(project)
  projectRefForExport.current = project
  const missingForExport = useRef(missingItemIds)
  missingForExport.current = missingItemIds
  const docRefForExport = useRef(state.doc)
  docRefForExport.current = state.doc

  /** Open the drawer: in settings, redetect encoders/disk space and collect each source's properties; while running or on a result page, show the current state. */
  const handleOpenExport = useCallback(() => {
    setExportOpen(true)
    if (exportCtl.getState().phase !== 'settings') return
    exportCtl.setBaseName(projectRefForExport.current.name || 'highlight')
    void (async () => {
      let outDir: string | null = null
      try {
        const s = await window.api?.settings?.get?.()
        outDir = typeof s?.defaultOutDir === 'string' ? s.defaultOutDir : null
      } catch {
        outDir = null
      }
      void exportCtl.init(outDir)
    })()
  }, [exportCtl])

  const handleCloseExport = useCallback(() => setExportOpen(false), [])

  // While the drawer is in settings, recollect source properties when the project, missing sources, or current-video info changes; the project track remains editable.
  useEffect(() => {
    if (!exportOpen || exportState.phase !== 'settings') return
    let cancelled = false
    const doc = state.doc
    void buildPlanBase(
      project,
      missingItemIds,
      { path: videoPath, info: { codec: doc.video.codec, width: doc.video.width, height: doc.video.height, fps: doc.video.fps, pix_fmt: doc.video.pix_fmt }, keyframes: doc.keyframes ?? [] },
      async (src) => (await window.api?.engine?.probe?.(src)) ?? null
    ).then((b) => {
      if (!cancelled) setExportBase(b)
    })
    return () => {
      cancelled = true
    }
  }, [exportOpen, exportState.phase, project, missingItemIds, state.doc, videoPath])

  // If export finishes while the drawer is minimized, show a Toast with a View action.
  const prevPhaseRef = useRef(exportState.phase)
  useEffect(() => {
    const prev = prevPhaseRef.current
    prevPhaseRef.current = exportState.phase
    if (prev !== 'running' || exportState.phase === 'running' || exportOpenRef.current) return
    const t = i18n.export
    toast({
      message: exportState.phase === 'failed' ? t.toastFailed : exportState.result?.cancelled ? t.toastCancelled : t.toastDone,
      action: { label: t.view, run: () => setExportOpen(true) }
    })
  }, [exportState.phase, exportState.result, toast])

  // Development only: ?drawer=… loads fake IPC to show drawer states directly for screenshots; dynamically imported and excluded from production bundles.
  const drawerFixtureDone = useRef(false)
  useEffect(() => {
    const kind = import.meta.env.DEV ? drawerFixtureRequested() : null
    if (!kind || drawerFixtureDone.current) return
    drawerFixtureDone.current = true
    void import('../dev/exportFixture').then(async (m) => {
      m.installExportFixtureApi(kind)
      handleOpenExport()
      await new Promise((r) => setTimeout(r, 150))
      if (kind === 'consent') await exportCtl.setQuality('precise')
      else if (kind !== 'settings') {
        const items = projectRefForExport.current.items.map((i) => ({ id: i.id, source: i.source, start: i.start, end: i.end }))
        void exportCtl.start(items)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded])

  /** Apply popover results: replace only suggested AI clips (keep added, skipped, and manual clips) and write to cache. */
  const handleApplyAutoClip = useCallback(
    (clips: Clip[]) => {
      suggestSeq.current++ // Pending automatic suggestions must not overwrite the result the user just applied.
      dispatch({ type: 'applyClips', clips: applyAutoClip(clipsRef.current, clips) })
      },
    []
  )

  /* ---------------- Project-track operations (Task 13) ---------------- */

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

  /** Delete the selected clip (Delete or track head); Toast Undo removes the history entry just added. */
  const deleteSelectedItem = useCallback(() => {
    const id = selProjId
    if (!id) return
    // Select an adjacent clip after deletion (prefer the next one) so keyboard focus does not fall to body.
    const items = projectRef.current.items
    const at = items.findIndex((i) => i.id === id)
    const neighbor = items[at + 1] ?? items[at - 1] ?? null
    apply(removeItem(projectRef.current, id))
    setSelProjId(neighbor ? neighbor.id : null)
    toast({
      message: i18n.studio.toast.deletedItem,
      action: { label: i18n.studio.toast.undo, run: undo }
    })
  }, [selProjId, apply, toast, undo])

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
  const handleNewProjectConfirmed = useCallback(() => {
    if (!newProject()) return
    setSelProjId(null)
    prevItemCount.current = 0
    toast({ message: i18n.studio.toast.newProject })
  }, [newProject, toast])

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

  /* ---------------- Project-mode guard (ignore source-document editing commands and show a Toast) ---------------- */

  const openAddEvent = useCallback(() => setAddEventAt(sourcePlayTime()), [sourcePlayTime])
  const gAddEvent = useMemo(() => guarded('addEvent', openAddEvent), [guarded, openAddEvent])
  /* ---------------- Overlays (when any is open, keymap handles only Esc for the topmost one) ---------------- */

  const overlayState: OverlayState = {
    addEvent: addEventAt !== null,
    autoClip: autoClipOpen,
    newProject: projDlgOpen,
    hostDialog: overlay.isOpen && overlay.kind !== 'shortcuts',
    exportDrawer: exportOpen,
    queuePopover: overlay.queueOpen,
    shortcuts: overlay.kind === 'shortcuts'
  }
  const overlayOpen = isAnyOverlayOpen(overlayState)
  const overlayStateRef = useRef(overlayState)
  overlayStateRef.current = overlayState

  /** Esc closes the topmost overlay. The new-project dialog and queue popover handle Esc themselves. */
  const closeOverlay = useCallback(() => {
    switch (topOverlay(overlayStateRef.current)) {
      case 'addEvent':
        setAddEventAt(null)
        break
      case 'autoClip':
        setAutoClipOpen(false)
        break
      case 'hostDialog':
      case 'shortcuts':
        overlay.close()
        break
      case 'exportDrawer':
        // While running, minimize to a badge without canceling; otherwise return to settings and close.
        if (exportCtl.getState().phase !== 'running') exportCtl.finish()
        setExportOpen(false)
        break
      default:
        break
    }
  }, [overlay, exportCtl])

  /* ---------------- keymap（spec §3.2.7） ---------------- */

  useKeymap(
    {
      play: togglePlay,
      speed: cycleSpeed,
      prevEvent: () => seekEvent(-1),
      nextEvent: () => seekEvent(1),
      seekBack: () => seekBy(-5),
      seekFwd: () => seekBy(5),
      zoomIn: () => {
        tlRef.current?.zoomIn()
        announce(i18n.studio.live.zoomIn)
      },
      zoomOut: () => {
        tlRef.current?.zoomOut()
        announce(i18n.studio.live.zoomOut)
      },
      zoomReset: () => {
        tlRef.current?.zoomReset()
        announce(i18n.studio.live.zoomReset)
      },
      quickOrSplit: handleQuickOrSplit,
      blade: toggleBlade,
      addEvent: gAddEvent,
      addAllToProject: addAllSuggestions,
      acceptSuggestion: handleAcceptSuggestion,
      skipSuggestion: handleSkipSuggestion,
      listPrev: () => setActiveClipId((prev) => nextSuggestion(shownClips, prev, -1)),
      listNext: () => setActiveClipId((prev) => nextSuggestion(shownClips, prev, 1)),
      playItem: playSelectedItem,
      deleteProjectItem: deleteSelectedItem,
      duplicateItem: duplicateSelectedItem,
      moveItemLeft: () => shiftSelectedItem(-1),
      moveItemRight: () => shiftSelectedItem(1),
      selectPrevItem: () => selectProjectItem(-1),
      selectNextItem: () => selectProjectItem(1),
      undo,
      redo,
      openExport: handleOpenExport,
      toggleAside: () => setAsideOpen((v) => !v),
      showShortcuts: overlay.openShortcuts,
      backToSource,
      closeOverlay
    },
    { screen: 'studio', mode: mode.mode, overlayOpen }
  )

  /* ---------------- aria-live (announce the current event) ---------------- */

  const activeEvent = useMemo(() => {
    let best: { id: string; t: number; type: string } | null = null
    for (const e of state.doc.events) {
      if (e.deleted) continue
      const d = Math.abs(e.t - currentTime)
      if (d > 1.2) continue
      if (!best || d < Math.abs(best.t - currentTime)) best = e
    }
    return best
  }, [state.doc.events, currentTime])

  const prevActiveId = useRef<string | null>(null)
  useEffect(() => {
    if (activeEvent?.id === prevActiveId.current) return
    prevActiveId.current = activeEvent?.id ?? null
    if (activeEvent) {
      const type = (i18n.timeline.types as Record<string, string>)[activeEvent.type] ?? activeEvent.type
      setLive(i18n.studio.live.event.replace('{type}', type).replace('{time}', formatTime(activeEvent.t)))
    }
  }, [activeEvent])

  /* ---------------- render ---------------- */

  if (loadError || blocked || !loaded) {
    return (
      <div className="studio">
        <SameDayVideos videoPath={videoPath} onOpenVideo={openSource} />
        {loadError ? <StudioLoadErrorView
          code={loadError.code}
          onRetry={() => handleNoticeAction('resume')}
          onCopy={() => handleNoticeAction('copyError')}
          onBack={onBack}
        /> : blocked ? <StudioBlockedView onBack={onBack} /> : <StudioLoadingView />}
      </div>
    )
  }

  /** Stay in the studio while export is running (leaving interrupts its status display); show a Toast instead. */
  const handleBack = requestBack

  const counts = chipCounts(state.doc.events)
  const eventCount = state.doc.events.filter((e) => !e.deleted).length
  const meta = [state.doc.video.width + '×' + state.doc.video.height, state.doc.video.codec.toUpperCase(), formatTime(duration), i18n.studio.meta.events.replace('{n}', String(eventCount))].join(' · ')

  return (
    <div className="studio">
      <StudioHeader
        title={baseName(videoPath)}
        meta={meta}
        statusDone={state.doc.analysis.status === 'done'}
        asideOpen={asideOpen}
        onBack={handleBack}
        onToggleAside={() => setAsideOpen((v) => !v)}
      />

      <div className="studio-body">
        <div className="studio-main">
          <SameDayVideos videoPath={videoPath} onOpenVideo={openSource} />
          {shownNotice && <NoticeBar notice={shownNotice} busy={proxyState === 'generating'} onAction={handleNoticeAction} />}
          <PlayerStage
            videoRef={videoRef}
            src={videoSrc}
            volume={cfg.previewVolume}
            muted={settings === null || cfg.previewMuted}
            mode={mode.mode}
            modeLabel={modeLabel}
            spectating={spectatingNow}
            recentCounted={recentCounted}
            onTogglePlay={togglePlay}
            onTimeUpdate={handleTimeUpdate}
            onLoadedMetadata={handleLoadedMetadata}
            onPlayingChange={handlePlayingChange}
            onEnded={handleVideoEnded}
            onError={handleVideoError}
          />

          <TransportBar
            playing={isPlaying}
            currentTime={currentTime}
            duration={duration}
            speed={speed}
            volume={cfg.previewVolume}
            muted={cfg.previewMuted}
            audioDisabled={settings === null}
            onVolumeChange={(value) => changePreviewAudio(value, false)}
            onToggleMute={() => cfg.previewVolume === 0
              ? changePreviewAudio(100, false)
              : changePreviewAudio(cfg.previewVolume, !cfg.previewMuted)}
            counts={counts}
            chipTypes={chipTypesFor(state.doc.game)}
            filter={state.filter}
            onTogglePlay={togglePlay}
            onCycleSpeed={cycleSpeed}
            onPrevEvent={() => seekEvent(-1)}
            onNextEvent={() => seekEvent(1)}
            onAddEvent={gAddEvent}
            onQuick={toggleBlade}
            bladeMode={bladeActive}
            onAutoClip={() => setAutoClipOpen((v) => !v)}
            autoClipOpen={autoClipOpen}
            onToggleFilter={(t) => dispatch({ type: 'setFilter', filter: toggleFilter(state.filter, t) })}
          />

          <div className="studio-tl" data-editor-lock>
            <TimelineCanvas
              ref={tlRef}
              duration={duration}
              currentTime={currentTime}
              events={state.doc.events}
              spectating={state.doc.spectating}
              clips={shownClips}
              filter={state.filter}
              onSeek={seekTo}
              onScrubStart={startScrub}
              onScrubEnd={endScrub}
              onHoverSeek={hoverSeek}
              bladeMode={bladeActive}
              onBladeModeChange={setBladeMode}
              onBladeRange={createBladeClip}
              onBladeTooShort={() => toast({ message: i18n.timeline.bladeTooShort })}
              disabled={overlayOpen || exporting}
              projectItem={sourceRange}
              onProjectTrim={trimSourceProjectItem}
              onSelectEvent={handleSelectEvent}
              seekBefore={cfg.before}
              onUpdateClip={(clip) => dispatch({ type: 'updateClip', clip })}
              currentEventId={activeEvent?.id}
              getPlayTime={sourcePlayTime}
              playing={isPlaying}
              followProject={mode.mode === 'project'}
            />
          </div>

          <ProjectTrack
            project={displayedProject}
            collapsed={projCollapsed}
            onToggleCollapsed={toggleProjCollapsed}
            selectedId={selProjId}
            onSelect={setSelProjId}
            currentId={mode.mode === 'project' && previewItem ? previewItem.id : null}
            progress={previewProgress}
            labelOf={labelOf}
            missingIds={missingItemIds}
            saveState={saveState}
            videoPath={videoPath}
            videoDuration={duration}
            onPlay={playProjectItem}
            onMissing={() => toast({ message: i18n.studio.track.missingToast })}
            onTrim={trimProjectItem}
            onMove={moveProjectItem}
            onRename={renameProject}
            onSplit={splitProjectAtPlayhead}
            onDuplicate={duplicateSelectedItem}
            onDelete={deleteSelectedItem}
            onUndo={undo}
            onRedo={redo}
            canUndo={canUndo}
            canRedo={canRedo}
            onNewProject={handleNewProjectConfirmed}
            onAddExternalVideo={handleAddExternalVideo}
            onExport={handleOpenExport}
            exportOpen={exportOpen}
            exportPercent={exporting ? (exportState.progress?.percent ?? 0) : null}
            onAddFromSource={addFirstSuggestion}
            onDialogOpenChange={setProjDlgOpen}
          />
        </div>

        {asideOpen && (
          <Aside
            hlCount={state.clips.length}
            locked={exporting}
          >
            <HighlightsTab
              clips={shownClips}
              events={state.doc.events}
              activeId={activeClipId}
              onActiveChange={setActiveClipId}
              onPreview={previewClip}
              onAccept={acceptClip}
              onSkip={skipClip}
              onRestore={restoreClip}
              onRemove={removeFromProject}
              onTuneParams={() => setAutoClipOpen(true)}
              project={displayedProject}
              onAddAll={addAllSuggestions}
            />
          </Aside>
        )}
      </div>

      {exportOpen && <ExportDrawer controller={exportCtl} project={project} base={exportBase} onClose={handleCloseExport} />}

      {autoClipOpen && (
        <AutoClipPopover
          defaults={cfg.autoclip}
          events={state.doc.events}
          duration={duration}
          onClose={() => setAutoClipOpen(false)}
          onApply={handleApplyAutoClip}
        />
      )}

      {addEventAt !== null && (
        <AddEventDialog
          time={addEventAt}
          types={chipTypesFor(state.doc.game)}
          onCancel={() => setAddEventAt(null)}
          onConfirm={(type) => {
            // If project mode is entered while this dialog is open (not expected), do not write to the source document.
            if (guardCommand(modeRef.current.mode, 'addEvent') === 'allow') {
              dispatch({ type: 'addManualEvent', t: addEventAt, eventType: type })
            }
            setAddEventAt(null)
          }}
        />
      )}

      <div className="sr-only" aria-live="polite">
        {live}
      </div>
    </div>
  )
}
