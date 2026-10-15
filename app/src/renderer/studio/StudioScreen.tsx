import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import '../styles/studio.css'
import { AutoClipParams, CacheDoc, EventType } from '../../shared/types'
import { formatTime, toCurrentTime } from '../../shared/time'
import { viewerReducer, ViewerState } from '../viewer/state'
import { createClipAt, supercut } from '../timeline/clips'
import { nextEvent } from '../timeline/model'
import { TimelineCanvas, TimelineHandle } from '../timeline/TimelineCanvas'
import { useKeymap } from '../hooks/useShortcuts'
import { useToast } from '../shell/ToastHost'
import { useOverlay } from '../shell/OverlayHost'
import { useProject } from '../editor/ProjectProvider'
import { addItems, ProjectItem, totalDuration } from '../editor/project'
import { EventList } from '../components/EventList'
import { ClipList } from '../components/ClipList'
import { AutoClipDialog } from '../components/AutoClipDialog'
import { ExportDialog } from '../components/ExportDialog'
import {
  FilePlus2,
  FolderOpen,
  ListVideo,
  Redo2,
  RefreshCw,
  Save,
  Sparkles,
  Undo2,
  ZoomIn,
  ZoomOut
} from '../components/icons'
import { checkSmooth, PlayabilityResult } from '../media/playability'
import { longFixtureRequested } from '../dev/fixture'
import { i18n } from '../i18n/zh-TW'
import { AddEventDialog } from './AddEventDialog'
import { ContextBanner } from './ContextBanner'
import { NoticeBar } from './NoticeBar'
import { PlayerStage } from './PlayerStage'
import { StudioHeader } from './StudioHeader'
import { TransportBar } from './TransportBar'
import { chipCounts, nearCount, toggleFilter } from './chips'
import { createMode, currentItem, isForeign, reduceMode } from './mode'
import { NoticeAction, studioNotice, StudioNotice } from './notices'

interface StudioScreenProps {
  videoPath: string
  onBack: () => void
  onOpenLegacyEditor: () => void
}

const DEFAULT_FILTER = new Set<EventType>(['knock', 'assist_knock', 'assist_elim', 'elim', 'squad_wipe'])
const DEFAULT_PLAYABILITY: PlayabilityResult = { supported: true, smooth: true, powerEfficient: true }

function baseName(p: string): string {
  return p.split(/[/\\]/).pop() ?? p
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
    profile: 'zh-TW',
    analysis: {
      status: 'done',
      progress_t: 0,
      engine_version: '0.1.0',
      templates_version: 'zh-TW@1',
      h_scale: 1.0
    },
    events: [],
    spectating: [],
    clips: [],
    keyframes: [],
    cache_path: ''
  }
}

function initViewerState(videoPath: string): ViewerState {
  return {
    doc: initialDoc(videoPath),
    selected: new Set<string>(),
    filter: new Set(DEFAULT_FILTER),
    clips: [],
    dirty: false
  }
}

/**
 * 工作室（spec §3.2）：播放器＋傳輸列＋來源時間軸＋專案軌（本任務為唯讀占位）＋側欄。
 * 模式膠囊／脈絡橫幅、狀態列（引擎異常、代理檔建議）、事件篩選 chip 帶計數。
 */
export function StudioScreen({ videoPath, onBack, onOpenLegacyEditor }: StudioScreenProps): JSX.Element {
  const { project, apply, undo, redo, canUndo, canRedo, newProject, openFile, saveFile } = useProject()
  const toast = useToast()
  const overlay = useOverlay()

  const videoRef = useRef<HTMLVideoElement>(null)
  const tlRef = useRef<TimelineHandle>(null)
  const [state, dispatch] = useReducer(viewerReducer, videoPath, initViewerState)
  const [mode, dispatchMode] = useReducer(reduceMode, videoPath, createMode)

  const [currentTime, setCurrentTime] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [speed, setSpeed] = useState(1.0)
  const [tab, setTab] = useState<'hl' | 'ev'>('hl')
  const [asideOpen, setAsideOpen] = useState(true)
  const [addEventAt, setAddEventAt] = useState<number | null>(null)
  const [autoClipOpen, setAutoClipOpen] = useState(false)

  const [reloadKey, setReloadKey] = useState(0)
  const [blocked, setBlocked] = useState(false)
  const [analysisError, setAnalysisError] = useState<string | null>(null)
  const [playability, setPlayability] = useState<PlayabilityResult>(DEFAULT_PLAYABILITY)
  const [proxyPath, setProxyPath] = useState<string | null>(null)
  const [proxyState, setProxyState] = useState<'none' | 'available' | 'generating'>('none')
  const [proxyDismissed, setProxyDismissed] = useState(false)
  const [live, setLive] = useState('')

  const duration = state.doc.video?.duration || 100
  const previewItem = currentItem(mode, project)
  const foreign = isForeign(mode, project)

  // 供 timeupdate 讀取（避免每幀重建 callback）
  const previewRef = useRef<{ item: ProjectItem | null; items: ProjectItem[] }>({ item: null, items: [] })
  previewRef.current = { item: previewItem, items: project.items }

  /* ---------------- 載入（沿用 Viewer 的 cache.load／engine.analyze 與去抖儲存） ---------------- */

  useEffect(() => {
    let cancelled = false
    setBlocked(false)
    setAnalysisError(null)
    const load = async (): Promise<void> => {
      if (longFixtureRequested()) {
        const { buildLongDoc } = await import('../dev/longFixture')
        if (!cancelled) dispatch({ type: 'analysisResult', doc: buildLongDoc(videoPath) })
        return
      }
      const api = window.api
      if (api?.engine?.analyze) {
        try {
          const res = (await api.engine.analyze({ path: videoPath })) as CacheDoc | null
          if (cancelled) return
          if (res) {
            // 防禦：分析尚未完成（Library 已攔截，這裡再擋一次）
            if (res.analysis?.status !== 'done') {
              setBlocked(true)
            } else {
              dispatch({ type: 'analysisResult', doc: res })
              void checkSmooth(res.video).then((p) => {
                if (!cancelled) setPlayability(p)
              })
            }
          }
        } catch (err) {
          if (!cancelled) {
            console.error('Failed to analyze/load cache:', err)
            setAnalysisError(err instanceof Error ? err.message : 'analysis failed')
          }
        }
      }
      if (api?.proxy?.get) {
        try {
          const p: string | null = await api.proxy.get(videoPath)
          if (!cancelled && p) {
            setProxyPath(p)
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
  }, [videoPath, reloadKey])

  // dirty：1 秒去抖後寫回快取
  useEffect(() => {
    if (!state.dirty || !state.doc.cache_path) return
    const timer = setTimeout(async () => {
      await window.api?.cache?.save?.(state.doc)
    }, 1000)
    return () => clearTimeout(timer)
  }, [state.dirty, state.doc])

  /* ---------------- 播放控制 ---------------- */

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

  const seekTo = useCallback((t: number) => {
    const el = videoRef.current
    const clamped = Math.max(0, t)
    if (el) el.currentTime = toCurrentTime(clamped, 0)
    setCurrentTime(clamped)
  }, [])

  const backToSource = useCallback(() => {
    dispatchMode({ type: 'backToSource' })
  }, [])

  const seekBy = useCallback(
    (delta: number) => {
      if (mode.mode === 'project') dispatchMode({ type: 'seekSource' })
      const now = videoRef.current?.currentTime ?? currentTime
      seekTo(Math.max(0, Math.min(duration, now + delta)))
    },
    [mode.mode, currentTime, duration, seekTo]
  )

  const seekEvent = useCallback(
    (dir: 1 | -1) => {
      if (mode.mode === 'project') dispatchMode({ type: 'seekSource' })
      const ev = nextEvent(state.doc.events, currentTime, dir, state.filter)
      if (ev) seekTo(Math.max(0, ev.t - 8))
    },
    [mode.mode, state.doc.events, currentTime, state.filter, seekTo]
  )

  const handleSelectEvent = useCallback(
    (ev: { t: number }) => {
      if (mode.mode === 'project') dispatchMode({ type: 'seekSource' })
      seekTo(Math.max(0, ev.t - 8))
    },
    [mode.mode, seekTo]
  )

  // 播放頭時間：專案模式在片段結尾自動接下一段
  const handleTimeUpdate = useCallback((t: number) => {
    setCurrentTime(t)
    const { item, items } = previewRef.current
    if (!item || t < item.end - 1e-3) return
    const idx = items.findIndex((i) => i.id === item.id)
    const next = idx >= 0 ? items[idx + 1] : undefined
    if (next) dispatchMode({ type: 'playItem', item: next })
    else videoRef.current?.pause()
  }, [])

  // 進入片段預覽：載入後 seek 到片段起點並播放（spec §3.5）
  useEffect(() => {
    const el = videoRef.current
    if (!el || !previewItem) return
    const start = Math.max(0, previewItem.start)
    const run = (): void => {
      el.currentTime = toCurrentTime(start, 0)
      void el.play().catch(() => {})
    }
    if (el.readyState >= 1) {
      run()
      return
    }
    el.addEventListener('loadedmetadata', run, { once: true })
    return () => el.removeEventListener('loadedmetadata', run)
  }, [previewItem?.id, previewItem?.start])

  const videoSrc = useMemo(() => {
    const file = foreign && previewItem ? previewItem.source : proxyPath ?? videoPath
    return `file://${file.replace(/\\/g, '/')}`
  }, [foreign, previewItem, proxyPath, videoPath])

  /* ---------------- 模式膠囊／脈絡 ---------------- */

  const previewIndex = previewItem ? project.items.findIndex((i) => i.id === previewItem.id) + 1 : 0
  const modeLabel = useMemo(() => {
    const m = i18n.studio.mode
    if (mode.mode === 'source' || !previewItem) return `${m.source} · ${baseName(videoPath)}`
    const item = m.item.replace('{i}', String(previewIndex)).replace('{n}', String(project.items.length))
    return `${m.project} · ${item} · ${formatTime(previewItem.start)}–${formatTime(previewItem.end)}`
  }, [mode.mode, previewItem, previewIndex, project.items.length, videoPath])

  const spectatingNow = useMemo(
    () => state.doc.spectating.some((s) => currentTime >= s.start && currentTime <= s.end),
    [state.doc.spectating, currentTime]
  )
  const recentCounted = useMemo(() => nearCount(state.doc.events, currentTime), [state.doc.events, currentTime])

  /* ---------------- 狀態列（引擎異常／代理檔） ---------------- */

  const notice: StudioNotice | null = useMemo(() => {
    const base = studioNotice({
      analysis: analysisError ? 'error' : 'done',
      playability,
      proxyState,
      errorCode: analysisError ?? undefined
    })
    if (proxyDismissed && base?.id === 'proxy-suggest') return null
    return base
  }, [analysisError, playability, proxyState, proxyDismissed])

  const busyNotice: StudioNotice | null = useMemo(
    () =>
      proxyState === 'generating'
        ? { id: 'proxy-generating', kind: 'info', title: i18n.studio.notices.proxyBusy, text: '', actions: [] }
        : null,
    [proxyState]
  )
  const shownNotice = notice ?? busyNotice

  const handleGenerateProxy = useCallback(async (): Promise<void> => {
    setProxyState('generating')
    try {
      const p: string | null = await window.api?.proxy?.generate?.(videoPath)
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
  }, [videoPath])

  const handleNoticeAction = useCallback(
    (a: NoticeAction): void => {
      if (a === 'resume') {
        setAnalysisError(null)
        setReloadKey((k) => k + 1)
      } else if (a === 'copyError') {
        void navigator.clipboard?.writeText(analysisError ?? '').catch(() => {})
        toast({ message: i18n.studio.toast.copied })
      } else if (a === 'generateProxy') {
        void handleGenerateProxy()
      } else if (a === 'later') {
        setProxyDismissed(true)
      }
    },
    [analysisError, handleGenerateProxy, toast]
  )

  /* ---------------- 編輯操作 ---------------- */

  const handleQuickOrSplit = useCallback(() => {
    if (mode.mode === 'project') {
      // Task 13：在播放頭分割目前選取的專案片段
      return
    }
    dispatch({ type: 'addClip', clip: createClipAt(currentTime, 8, 4, duration) })
  }, [mode.mode, currentTime, duration])

  const handleAddAll = useCallback(() => {
    if (state.clips.length === 0) return
    const items = state.clips.map((c) => ({ source: videoPath, start: c.start, end: c.end }))
    apply(addItems(project, items))
    toast({
      message: i18n.studio.toast.added,
      action: { label: i18n.studio.toast.undo, run: undo }
    })
  }, [state.clips, videoPath, project, apply, toast, undo])

  const handleSupercut = useCallback(() => {
    if (state.selected.size === 0) return
    const clips = supercut(state.doc.events, state.selected, 8, 4, duration)
    for (const c of clips) dispatch({ type: 'addClip', clip: c })
    setTab('hl')
  }, [state.selected, state.doc.events, duration])

  const handleDeleteSelected = useCallback(() => {
    const ids = [...state.selected]
    if (ids.length === 0) return
    for (const id of ids) dispatch({ type: 'deleteEvent', id })
    toast({
      message: i18n.studio.toast.deletedEvents.replace('{n}', String(ids.length)),
      action: { label: i18n.studio.toast.undo, run: () => ids.forEach((id) => dispatch({ type: 'restoreEvent', id })) }
    })
  }, [state.selected, toast])

  const handleDeleteEvent = useCallback(
    (id: string) => {
      dispatch({ type: 'deleteEvent', id })
      toast({
        message: i18n.studio.toast.deletedEvents.replace('{n}', '1'),
        action: { label: i18n.studio.toast.undo, run: () => dispatch({ type: 'restoreEvent', id }) }
      })
    },
    [toast]
  )

  const clearSelection = useCallback(() => {
    for (const id of state.selected) dispatch({ type: 'toggleSelectEvent', id })
  }, [state.selected])

  const handleBoxSelect = useCallback(
    (ids: string[], _t1: number, _t2: number, additive: boolean) => {
      const want = new Set(additive ? [...state.selected, ...ids] : ids)
      for (const id of want) if (!state.selected.has(id)) dispatch({ type: 'toggleSelectEvent', id })
      for (const id of state.selected) if (!want.has(id)) dispatch({ type: 'toggleSelectEvent', id })
    },
    [state.selected]
  )

  const handleOpenExport = useCallback(() => {
    overlay.open(<ExportDialog project={project} onClose={overlay.close} />)
  }, [overlay, project])

  const handleAutoClipGenerate = useCallback(
    async (params: AutoClipParams): Promise<void> => {
      const api = window.api
      if (!api?.engine?.autoclip) return
      try {
        const res = await api.engine.autoclip({ events: state.doc.events, params, duration })
        if (res?.clips) {
          dispatch({ type: 'setAiClips', clips: res.clips })
          setTab('hl')
        }
      } catch (err) {
        console.error('Failed to run autoclip:', err)
      }
    },
    [state.doc.events, duration]
  )

  /* ---------------- keymap（spec §3.2.7） ---------------- */

  useKeymap(
    {
      play: togglePlay,
      speed: cycleSpeed,
      prevEvent: () => seekEvent(-1),
      nextEvent: () => seekEvent(1),
      seekBack: () => seekBy(-5),
      seekFwd: () => seekBy(5),
      zoomIn: () => tlRef.current?.zoomIn(),
      zoomOut: () => tlRef.current?.zoomOut(),
      zoomReset: () => tlRef.current?.zoomReset(),
      quickOrSplit: handleQuickOrSplit,
      addEvent: () => setAddEventAt(videoRef.current?.currentTime ?? currentTime),
      supercut: handleSupercut,
      addAllToProject: handleAddAll,
      deleteSelectedEvents: handleDeleteSelected,
      seekSelectedEvent: () => {
        const id = [...state.selected][0]
        const ev = state.doc.events.find((e) => e.id === id)
        if (ev) handleSelectEvent(ev)
      },
      undo,
      redo,
      saveProjectFile: () => void saveFile(),
      openExport: handleOpenExport,
      toggleAside: () => setAsideOpen((v) => !v),
      backToSource,
      closeOverlay: clearSelection
    },
    { screen: 'studio', mode: mode.mode, enabled: addEventAt === null }
  )

  /* ---------------- aria-live（朗讀目前事件／選取數） ---------------- */

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

  const prevSelectedCount = useRef(0)
  useEffect(() => {
    if (state.selected.size === prevSelectedCount.current) return
    prevSelectedCount.current = state.selected.size
    setLive(i18n.studio.live.selected.replace('{n}', String(state.selected.size)))
  }, [state.selected.size])

  /* ---------------- render ---------------- */

  if (blocked) {
    return (
      <div className="studio-blocked" role="alert">
        <p>{i18n.studio.openBlocked}</p>
        <button type="button" className="btn-ghost" onClick={onBack}>
          {i18n.studio.back}
        </button>
      </div>
    )
  }

  const counts = chipCounts(state.doc.events)
  const eventCount = state.doc.events.filter((e) => !e.deleted).length
  const meta = [state.doc.video.width + '×' + state.doc.video.height, state.doc.video.codec.toUpperCase(), formatTime(duration), i18n.studio.meta.events.replace('{n}', String(eventCount))].join(' · ')

  return (
    <div className="studio">
      <StudioHeader
        title={baseName(videoPath)}
        meta={meta}
        statusDone={state.doc.analysis.status === 'done'}
        mode={mode.mode}
        exportCount={project.items.length}
        asideOpen={asideOpen}
        onBack={onBack}
        onAutoClip={() => setAutoClipOpen(true)}
        onQuick={handleQuickOrSplit}
        onExport={handleOpenExport}
        onToggleAside={() => setAsideOpen((v) => !v)}
      />

      <div className="studio-body">
        <div className="studio-main">
          {shownNotice && <NoticeBar notice={shownNotice} busy={proxyState === 'generating'} onAction={handleNoticeAction} />}
          {mode.mode === 'project' && previewItem && (
            <ContextBanner
              index={previewIndex}
              label={`${formatTime(previewItem.start)}–${formatTime(previewItem.end)}`}
              sourceName={baseName(previewItem.source)}
              onBackToSource={backToSource}
            />
          )}

          <PlayerStage
            videoRef={videoRef}
            src={videoSrc}
            mode={mode.mode}
            modeLabel={modeLabel}
            spectating={spectatingNow}
            recentCounted={recentCounted}
            onTogglePlay={togglePlay}
            onTimeUpdate={handleTimeUpdate}
            onPlayingChange={setIsPlaying}
          />

          <TransportBar
            playing={isPlaying}
            currentTime={currentTime}
            duration={duration}
            speed={speed}
            counts={counts}
            filter={state.filter}
            onTogglePlay={togglePlay}
            onCycleSpeed={cycleSpeed}
            onPrevEvent={() => seekEvent(-1)}
            onNextEvent={() => seekEvent(1)}
            onAddEvent={() => setAddEventAt(videoRef.current?.currentTime ?? currentTime)}
            onToggleFilter={(t) => dispatch({ type: 'setFilter', filter: toggleFilter(state.filter, t) })}
          />

          <div className={`studio-tl${foreign ? ' grayed' : ''}`}>
            <TimelineCanvas
              ref={tlRef}
              duration={duration}
              currentTime={currentTime}
              events={state.doc.events}
              spectating={state.doc.spectating}
              clips={state.clips}
              filter={state.filter}
              onSeek={seekTo}
              onSelectEvent={handleSelectEvent}
              onUpdateClip={(clip) => dispatch({ type: 'updateClip', clip })}
              selected={state.selected}
              currentEventId={activeEvent?.id}
              onToggleSelect={(id) => dispatch({ type: 'toggleSelectEvent', id })}
              onBoxSelect={handleBoxSelect}
              getPlayTime={() => videoRef.current?.currentTime ?? 0}
              playing={isPlaying}
              onPlayToggle={togglePlay}
            />
            <div className="tl-zoom">
              <button type="button" className="icon-btn" aria-label={i18n.studio.transport.zoomOut} onClick={() => tlRef.current?.zoomOut()}>
                <ZoomOut className="ic" />
              </button>
              <button type="button" className="icon-btn" aria-label={i18n.studio.transport.zoomIn} onClick={() => tlRef.current?.zoomIn()}>
                <ZoomIn className="ic" />
              </button>
              <button type="button" className="icon-btn" aria-label={i18n.studio.transport.zoomReset} onClick={() => tlRef.current?.zoomReset()}>
                <RefreshCw className="ic" />
              </button>
            </div>
          </div>

          <section className="studio-track" data-zone="proj" aria-label={i18n.studio.track.title}>
            <div className="track-bar">
              <span className="track-title">{i18n.studio.track.title}</span>
              <span className="dim">
                {i18n.studio.track.itemCount.replace('{n}', String(project.items.length))} ·{' '}
                {i18n.studio.track.total.replace('{time}', formatTime(totalDuration(project)))}
              </span>
              <div className="track-actions">
                <button type="button" className="icon-btn" aria-label={i18n.studio.track.undo} disabled={!canUndo} onClick={undo}>
                  <Undo2 className="ic" />
                </button>
                <button type="button" className="icon-btn" aria-label={i18n.studio.track.redo} disabled={!canRedo} onClick={redo}>
                  <Redo2 className="ic" />
                </button>
                <button type="button" className="icon-btn" aria-label={i18n.studio.track.newProject} onClick={newProject}>
                  <FilePlus2 className="ic" />
                </button>
                <button type="button" className="icon-btn" aria-label={i18n.studio.track.openFile} onClick={() => void openFile()}>
                  <FolderOpen className="ic" />
                </button>
                <button type="button" className="icon-btn" aria-label={i18n.studio.track.saveFile} onClick={() => void saveFile()}>
                  <Save className="ic" />
                </button>
                <button type="button" className="btn-ghost" onClick={onOpenLegacyEditor}>
                  {i18n.studio.track.legacy}
                </button>
              </div>
              <div className="track-spacer" />
              <button type="button" className="btn-accent" onClick={handleAddAll} disabled={state.clips.length === 0}>
                {i18n.studio.track.addAll} <kbd>{i18n.studio.track.addAllKey}</kbd>
              </button>
            </div>
            <div className="track-items" role="list">
              {project.items.length === 0 ? (
                <span className="dim">{i18n.studio.track.empty}</span>
              ) : (
                project.items.map((it) => (
                  <div
                    key={it.id}
                    role="listitem"
                    tabIndex={0}
                    className={`track-chip${previewItem?.id === it.id ? ' on' : ''}`}
                    onClick={() => dispatchMode({ type: 'playItem', item: it })}
                  >
                    <span className="mono">
                      {formatTime(it.start)}–{formatTime(it.end)}
                    </span>
                    <span className="track-chip-src dim">{baseName(it.source)}</span>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>

        {asideOpen && (
          <aside className={`studio-aside${foreign ? ' grayed' : ''}`} aria-label={i18n.studio.tabs.asideLabel}>
            <div className="aside-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'hl'}
                className={`aside-tab${tab === 'hl' ? ' on' : ''}`}
                onClick={() => setTab('hl')}
              >
                <Sparkles className="ic sm" /> {i18n.studio.tabs.hl} {state.clips.length}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'ev'}
                className={`aside-tab${tab === 'ev' ? ' on' : ''}`}
                onClick={() => setTab('ev')}
              >
                <ListVideo className="ic sm" /> {i18n.studio.tabs.ev} {eventCount}
              </button>
            </div>
            {tab === 'hl' ? (
              <div className="aside-panel" data-zone="hl" role="tabpanel">
                {state.clips.length === 0 ? (
                  <p className="dim">{i18n.studio.shelves.hlPlaceholder}</p>
                ) : (
                  <ClipList
                    clips={state.clips}
                    onPlayClip={(c) => seekTo(c.start)}
                    onRemoveClip={(id) => dispatch({ type: 'removeClip', id })}
                  />
                )}
              </div>
            ) : (
              <div className="aside-panel" data-zone="ev" role="tabpanel">
                {state.doc.events.length === 0 ? (
                  <p className="dim">{i18n.studio.shelves.evPlaceholder}</p>
                ) : (
                  <EventList
                    events={state.doc.events}
                    selected={state.selected}
                    filter={state.filter}
                    onSelectEvent={handleSelectEvent}
                    onToggleSelect={(id) => dispatch({ type: 'toggleSelectEvent', id })}
                    onToggleOverride={(id, value) => dispatch({ type: 'setOverride', id, value })}
                    onDeleteEvent={handleDeleteEvent}
                  />
                )}
              </div>
            )}
          </aside>
        )}
      </div>

      <AutoClipDialog isOpen={autoClipOpen} onClose={() => setAutoClipOpen(false)} onGenerate={handleAutoClipGenerate} />

      {addEventAt !== null && (
        <AddEventDialog
          time={addEventAt}
          onCancel={() => setAddEventAt(null)}
          onConfirm={(type) => {
            dispatch({ type: 'addManualEvent', t: addEventAt, eventType: type })
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
