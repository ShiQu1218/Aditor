import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react'
import '../styles/studio.css'
import '../styles/projectTrack.css'
import { CacheDoc, type Clip } from '../../shared/types'
import { formatTime } from '../../shared/time'
import { viewerReducer } from '../viewer/state'
import { STUDIO_SETTINGS_DEFAULTS, subscribeStudioSettings, type StudioSettings } from './studioSettings'
import { TimelineCanvas, TimelineHandle } from '../timeline/TimelineCanvas'
import { useKeymap } from '../hooks/useShortcuts'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { useToast } from '../shell/ToastHost'
import { useOverlay } from '../shell/OverlayHost'
import { useProject } from '../editor/ProjectProvider'
import { ProjectItem, trimItem } from '../editor/project'
import { ExportDrawer } from './ExportDrawer'
import { createExportController } from './exportController'
import { windowExportApi } from './exportApi'
import { ExportPlanBase } from './exportPlanBase'
import { useEditorLock } from '../editor/useEditorLock'
import { PlayabilityResult } from '../media/playability'
import { i18n, settingsI18n } from '../i18n'
import { AddEventDialog } from './AddEventDialog'
import { Aside } from './Aside'
import { AutoClipPopover } from './AutoClipPopover'
import { clipTitle, linkedClip, linkedItem, mirrorLinkedClips, nextSuggestion, withProjectStatus } from './highlights'
import { HighlightsTab } from './HighlightsTab'
import { NoticeBar } from './NoticeBar'
import { PlayerStage } from './PlayerStage'
import { PlaybackControls } from './PlaybackControls'
import { ProjectTrack } from './ProjectTrack'
import { StudioHeader } from './StudioHeader'
import { SameDayVideos } from './SameDayVideos'
import { StudioBlockedView, StudioLoadErrorView, StudioLoadingView } from './StudioStates'
import { TransportBar } from './TransportBar'
import { chipCounts, nearCount, toggleFilter, chipTypesFor } from './chips'
import { createMode, currentItem, reduceMode } from './mode'
import { guardCommand } from './modeGuard'
import { isAnyOverlayOpen, OverlayState, topOverlay } from './overlays'
import { RemoveChoiceDialog } from '../library/RemoveChoiceDialog'
import { baseName, DEFAULT_PLAYABILITY, initViewerState, normPath, type ProjectPlaybackRequest } from './studioScreenModel'
import { useStudioDocument } from './useStudioDocument'
import { useStudioSuggestions } from './useStudioSuggestions'
import { useStudioSourcePlayback } from './useStudioSourcePlayback'
import { useStudioPlayback } from './useStudioPlayback'
import { useStudioNotices } from './useStudioNotices'
import { useStudioVideoRemoval } from './useStudioVideoRemoval'
import { useStudioSourceEdits } from './useStudioSourceEdits'
import { useStudioExport } from './useStudioExport'
import { useStudioProjectTrack } from './useStudioProjectTrack'

export type { ProjectPlaybackRequest }

interface StudioScreenProps {
  videoPath: string
  onBack: () => void
  /** Register the same source-save/export guard used by the header for shell navigation. */
  onRegisterLeaveGuard?: (guard: () => boolean) => () => void
  /** Notify the owner even if deletion finishes after leaving the studio. */
  onVideoRemoved?: (path: string) => void
  onOpenVideo: (path: string, request?: ProjectPlaybackRequest) => void
  playbackRequest?: ProjectPlaybackRequest
  onPlaybackRequestConsumed?: () => void
  /** Test seam: provide an already-loaded document directly (skip loading; used for the SSR smoke test). */
  preloadedDoc?: CacheDoc
}

/**
 * Studio (spec §3.2): player, transport bar, source timeline, project track, and sidebar.
 * Mode pill/context banner, status bar (engine errors and proxy suggestions), and counted event-filter chips.
 * Project track (Task 13): clip cards, drag reordering, handle trimming, track-head actions, and the new-project dialog.
 * Logic lives in the useStudio* hooks, called in the original effect order; all state stays here.
 */
export function StudioScreen({ videoPath, onBack, onRegisterLeaveGuard, onVideoRemoved, onOpenVideo, playbackRequest, onPlaybackRequestConsumed, preloadedDoc }: StudioScreenProps): JSX.Element {
  const {
    project,
    apply,
    undo,
    redo,
    canUndo,
    canRedo,
    newProject,
    openProject,
    saveState,
    missingItemIds
  } = useProject()
  const toast = useToast()
  const overlay = useOverlay()

  /* ---------------- Export drawer (Task 15): the controller lives at the studio level, so export continues when the drawer is minimized to a badge. ---------------- */
  const exportCtl = useMemo(() => createExportController(windowExportApi, 'highlight'), [])
  const exportState = useSyncExternalStore(exportCtl.subscribe, exportCtl.getState, exportCtl.getState)
  const exporting = exportState.phase === 'running'
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
  const [playability, setPlayability] = useState<PlayabilityResult>(DEFAULT_PLAYABILITY)
  const [proxyPath, setProxyPath] = useState<string | null>(null)
  const [proxyState, setProxyState] = useState<'none' | 'available' | 'generating'>('none')
  const [videoMissing, setVideoMissing] = useState(false)
  const [live, setLive] = useState('')
  const [removeChoice, setRemoveChoice] = useState<string | null>(null)
  const [removingVideo, setRemovingVideo] = useState(false)
  const removalPending = useRef(false)
  const removalInFlight = useRef(false)
  useEditorLock(exporting || removingVideo)

  const duration = state.doc.video?.duration || 100
  const displayedProject = useMemo(() => sourceTrim
    ? trimItem(project, sourceTrim.id, sourceTrim.edge, sourceTrim.t, duration) : project, [project, sourceTrim, duration])
  const previewItem = currentItem(mode, project)
  const sourceProjectItem = previewItem ?? displayedProject.items.find((item) => item.id === selProjId)
  const sourceRange = sourceProjectItem && normPath(sourceProjectItem.source) === normPath(videoPath)
    ? displayedProject.items.find((item) => item.id === sourceProjectItem.id) ?? null : null
  // Determine “added” from actual project content (deleting a project clip or creating a new project returns the card and track to suggested).
  const shownClips = useMemo(() => withProjectStatus(state.clips, videoPath, displayedProject), [state.clips, videoPath, displayedProject])
  // A selected item still on its highlight's range is drawn as that highlight (following the trim draft), so the source track shows one range.
  const committedSource = sourceRange ? project.items.find((item) => item.id === sourceRange.id) : undefined
  const linkedSource = committedSource ? linkedClip(committedSource, project, state.clips) : null
  const timelineClips = useMemo(() => linkedSource && sourceRange
    ? shownClips.map((c) => (c.id === linkedSource.id ? { ...c, start: sourceRange.start, end: sourceRange.end } : c))
    : shownClips, [shownClips, linkedSource, sourceRange])
  const allowUnanalyzed = useRef(Boolean(playbackRequest)).current
  const switchingSourceRef = useRef(false)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  const stateRef = useRef(state)
  stateRef.current = state
  // Linked highlights mirror their project item. Re-run when the project changes (trim, undo, redo) or this video's
  // clips load or change membership, but not on a clip's own edge drag, which would snap it back mid-drag.
  const clipIds = useMemo(() => state.clips.map((c) => c.id).join('\n'), [state.clips])
  useEffect(() => {
    for (const clip of mirrorLinkedClips(project, videoPath, stateRef.current.clips)) dispatch({ type: 'updateClip', clip })
  }, [project, videoPath, clipIds])

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

  // Analysis generation (increment after each load or reanalysis): plan suggestions only once per generation.
  const [analysisGen, setAnalysisGen] = useState(preloadedDoc ? 1 : 0)

  const { cacheSaver, canLeaveStudio } = useStudioDocument({
    videoPath, reloadKey, preloadedDoc, allowUnanalyzed, loaded, state, stateRef, dispatch, exportCtl, toast,
    onRegisterLeaveGuard, setBlocked, setLoadError, setLoaded, setAnalysisGen, setPlayability, setProxyPath, setProxyState
  })

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

  const { handleApplyAutoClip } = useStudioSuggestions({
    settings, state, dispatch, analysisGen, duration, shownClips, currentTime, setActiveClipId
  })

  /* ---------------- Playback controls ---------------- */

  const source = useStudioSourcePlayback({
    videoRef, videoPath, proxyPath, mode, dispatchMode, speed, setSpeed, isPlaying, setCurrentTime, setLive, duration,
    events: state.doc.events, filter: state.filter, before: cfg.before, project, previewRef, projectRef
  })
  const {
    modeRef, videoSrc, handleLoadedMetadata, sourcePlayTime, announce, togglePlay, cycleSpeed, seekTo, startScrub, endScrub,
    hoverSeek, backToSource, seekBy, seekEvent, handleSelectEvent
  } = source

  const {
    openSource, playProjectItem, handlePlayingChange, handleVideoEnded, handleVideoError, handleTimeUpdate
  } = useStudioPlayback({
    source, videoRef, videoPath, project, projectRef, previewRef, previewItem, missingItemIds, isPlaying, loaded, playbackRequest,
    onPlaybackRequestConsumed, onOpenVideo, exportCtl, toast, stateRef, cacheSaver, removalPending, switchingSourceRef,
    dispatchMode, setSelProjId, setCurrentTime, setPreviewTime, setIsPlaying, setVideoMissing
  })

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

  const { shownNotice, requestBack, handleNoticeAction } = useStudioNotices({
    videoPath, reloadKey, duration, docAnalysis: state.doc.analysis, videoMissing, setVideoMissing, playability, proxyState,
    setProxyState, setProxyPath, proxySuggest: cfg.proxySuggest, loadError, setLoadError, setReloadKey, removalPending,
    canLeaveStudio, onBack, toast
  })

  const { removeVideo, requestRemoveVideo } = useStudioVideoRemoval({
    videoPath, videoRef, exportCtl, toast, onVideoRemoved, stateRef, cacheSaver, mountedRef, switchingSourceRef,
    loadedSrcRef: source.loadedSrcRef, pendingSeekRef: source.pendingSeekRef, removalPending, removalInFlight, setRemoveChoice,
    setRemovingVideo
  })

  const removeDialog = removeChoice !== null && <RemoveChoiceDialog
    title={i18n.library.card.removeChoiceTitle}
    message={i18n.library.card.removeChoiceMessage.replace('{name}', baseName(removeChoice))}
    deleteLabel={i18n.library.card.deleteSource}
    removeLabel={i18n.library.card.removeFromLibrary}
    cancelLabel={i18n.library.card.cancel}
    onDeleteSource={() => { void removeVideo(removeChoice, true) }}
    onRemoveOnly={() => { void removeVideo(removeChoice, false) }}
    onCancel={() => { setRemoveChoice(null); removalPending.current = false }}
  />
  const removeDisabled = exporting || removingVideo || removeChoice !== null

  /* ---------------- Editing operations ---------------- */

  const {
    guarded, splitProjectAtPlayhead, toggleBlade, handleQuickOrSplit, createBladeClip, bladeActive, previewClip, acceptClip,
    skipClip, restoreClip, removeFromProject, addAllSuggestions, handleAcceptSuggestion, handleSkipSuggestion
  } = useStudioSourceEdits({
    videoPath, videoRef, mode, modeRef, dispatchMode, dispatch, apply, toast, projectRef, previewRef, currentTime, shownClips,
    activeClipId, setActiveClipId, setSelProjId, bladeMode, setBladeMode, backToSource, seekTo
  })

  /** Open the drawer: in settings, redetect encoders/disk space and collect each source's properties; while running or on a result page, show the current state. */
  const handleOpenExport = useCallback(() => {
    setExportOpen(true)
    if (exportCtl.getState().phase !== 'settings') return
    exportCtl.setBaseName(projectRef.current.name || 'highlight')
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

  useStudioExport({
    exportCtl, exportState, exportOpen, exportOpenRef, setExportOpen, setExportBase, handleOpenExport, project, projectRef,
    missingItemIds, doc: state.doc, videoPath, loaded, toast
  })

  /* ---------------- Project-track operations (Task 13) ---------------- */

  const {
    trimProjectItem, trimSourceProjectItem, moveProjectItem, renameProject, duplicateSelectedItem, deleteSelectedItem,
    selectProjectItem, shiftSelectedItem, playSelectedItem, toggleProjCollapsed, handleNewProjectConfirmed, handleOpenProject,
    handleAddExternalVideo, addFirstSuggestion
  } = useStudioProjectTrack({
    project, projectRef, apply, undo, newProject, projectId: project.id, openProject, toast, exportCtl, videoPath, duration, selProjId, setSelProjId, setSourceTrim,
    projCollapsed, setSettings, playProjectItem, mountedRef, switchingSourceRef, shownClips, acceptClip
  })
  /** Dragging a highlight's own edge also trims the project item added from it (one undoable edit, on release). */
  const trimLinkedItem = useCallback((before: Clip, after: Clip): void => {
    const item = linkedItem(before, projectRef.current)
    if (!item) return
    const edge = after.start !== before.start ? 'start' : 'end'
    trimProjectItem(item.id, edge, after[edge])
  }, [trimProjectItem])

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
  const overlayOpen = isAnyOverlayOpen(overlayState) || removeChoice !== null || removingVideo
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
        <SameDayVideos videoPath={videoPath} onOpenVideo={openSource} onRemove={requestRemoveVideo} removeDisabled={removeDisabled} />
        {removeDialog}
        {loadError ? <StudioLoadErrorView
          code={loadError.code}
          message={loadError.message}
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
        onRemove={() => { void requestRemoveVideo(videoPath) }}
        removeDisabled={removeDisabled}
      />

      <div className="studio-body">
        <div className="studio-main">
          <SameDayVideos videoPath={videoPath} onOpenVideo={openSource} onRemove={requestRemoveVideo} removeDisabled={removeDisabled} />
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
          >
            <PlaybackControls
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
              onTogglePlay={togglePlay}
              onCycleSpeed={cycleSpeed}
              onPrevEvent={() => seekEvent(-1)}
              onNextEvent={() => seekEvent(1)}
              onSeek={seekTo}
              onScrubStart={startScrub}
              onScrubEnd={endScrub}
            />
          </PlayerStage>

          <TransportBar
            counts={counts}
            chipTypes={chipTypesFor(state.doc.game)}
            filter={state.filter}
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
              rounds={state.doc.rounds}
              clips={timelineClips}
              activeClipId={linkedSource?.id ?? null}
              showProjectRange={!linkedSource}
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
              onClipTrimCommit={trimLinkedItem}
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
            projectId={project.id}
            onNewProject={handleNewProjectConfirmed}
            onOpenProject={handleOpenProject}
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

      {removeDialog}
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
