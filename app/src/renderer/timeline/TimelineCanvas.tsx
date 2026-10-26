import React, { useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { isLowPerf, subscribeLowPerf } from '../perf/lowPerf'
import '../styles/timeline.css'
import { Clip, EngineEvent, EventType, SpecInterval, Round } from '../../shared/types'
import { View, TimelineZoom, ZoomMode, maxCustomZoom, pan, resizeTimeline, setCustomZoom, setZoomMode, updateTimelineView, zoomTimeline } from './model'
import { i18n } from '../i18n'
import { layoutTimeline, TimelineLayout } from './layout'
import { createRedrawScheduler, DrawModel, drawTimeline, readTheme, resetThemeCache } from './draw'
import { Playhead, playbackPollMs, playheadTarget } from './Playhead'
import { TimelineScrollbar } from './TimelineScrollbar'
import { useTimelineInteractions, type InteractionOptions } from './useTimelineInteractions'

/** Imperative timeline operations (the outer layer invokes Ctrl +/−/0 from keymap). */
export interface TimelineHandle {
  zoomIn: () => void
  zoomOut: () => void
  zoomReset: () => void
}

interface TimelineCanvasProps extends Pick<InteractionOptions,
  'projectItem' | 'onProjectTrim' | 'onScrubStart' | 'onScrubEnd' | 'onHoverSeek' |
  'bladeMode' | 'onBladeModeChange' | 'onBladeRange' | 'onBladeTooShort' | 'disabled' | 'onClipTrimCommit'> {
  duration: number
  currentTime: number
  events: EngineEvent[]
  spectating: SpecInterval[]
  /** Valorant rounds, drawn as a won/lost strip. */
  rounds?: Round[]
  clips: Clip[]
  filter: Set<EventType>
  onSeek: (t: number) => void
  onSelectEvent?: (e: EngineEvent) => void
  onUpdateClip?: (clip: Clip) => void
  /* Optional props below. */
  height?: number
  selected?: Set<string>
  /** Event containing the current playhead (drawn with an outer ring). */
  currentEventId?: string
  activeClipId?: string | null
  /** Clicking an event icon seeks to t - seekBefore (8 seconds by default; used only when onSelectEvent is not provided). */
  seekBefore?: number
  onToggleSelect?: (id: string) => void
  /** Read current time during playback via rAF (e.g. video.currentTime); the playhead does not trigger React rerenders. */
  getPlayTime?: () => number
  playing?: boolean
  /** Keep the source playhead visible at custom zoom levels during project preview. */
  followProject?: boolean
  /** False keeps the project item's trim handles but leaves its range undrawn (a clip already draws the same range). */
  showProjectRange?: boolean
}

const EMPTY_SET: Set<string> = new Set()
const MAX_DPR = 2
const ZOOM_IN_FACTOR = 0.7
const ZOOM_OUT_FACTOR = 1.4

export const TimelineCanvas = React.forwardRef<TimelineHandle, TimelineCanvasProps>(function TimelineCanvas(
  {
    duration,
    currentTime,
    events,
    spectating,
    rounds,
    clips,
    filter,
    onSeek,
    onSelectEvent,
    onUpdateClip,
    height = 132,
    selected = EMPTY_SET,
    currentEventId,
    activeClipId = null,
    seekBefore = 8,
    onToggleSelect,
    projectItem,
    onProjectTrim,
    onScrubStart,
    onScrubEnd,
    onHoverSeek,
    bladeMode,
    onBladeModeChange,
    onBladeRange,
    onBladeTooShort,
    disabled,
    onClipTrimCommit,
    showProjectRange = true,
    getPlayTime,
    playing,
    followProject
  }: TimelineCanvasProps,
  ref
): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const [zoomState, setZoomState] = useState<TimelineZoom>(() => ({
    mode: 'full',
    customZoom: 1,
    view: { duration: Math.max(1, duration), start: 0, span: Math.max(1, duration), width: 800 }
  }))
  const { view, mode } = zoomState
  const viewRef = useRef(view)
  viewRef.current = view
  const customZoom = Math.min(maxCustomZoom(view.duration), Math.max(1, zoomState.customZoom))
  const canvasId = useId()
  const playback = useRef({ playing, time: currentTime, getTime: getPlayTime })
  playback.current = { playing, time: currentTime, getTime: getPlayTime }
  const setView = useCallback((update: (v: View) => View): void => {
    setZoomState((state) => updateTimelineView(state, update))
  }, [])
  const changeMode = (next: ZoomMode): void => {
    setZoomState((state) => setZoomMode(state, next, playheadTarget(playback.current)))
  }
  // Center all custom zoom operations on the playhead (wheel, buttons, shortcuts, and zoom slider).
  const changeZoom = useCallback((factor: number): void => {
    setZoomState((state) => zoomTimeline(state, factor, playheadTarget(playback.current)))
  }, [])

  // When duration changes, preserve the mode and custom scale, clamped to the new source range.
  useEffect(() => {
    setZoomState((state) => resizeTimeline(state, duration, state.view.width, playheadTarget(playback.current)))
  }, [duration])

  // Width: ResizeObserver.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const update = (): void => {
      const w = el.clientWidth
      setZoomState((state) => resizeTimeline(state, state.view.duration, w, playheadTarget(playback.current)))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Imperative zoom (Ctrl +/−/0 from keymap), centered on the playhead.
  useImperativeHandle(
    ref,
    () => ({
      zoomIn: () => changeZoom(ZOOM_IN_FACTOR),
      zoomOut: () => changeZoom(ZOOM_OUT_FACTOR),
      zoomReset: () => changeMode('full')
    }),
    [changeZoom]
  )

  const layout = useMemo(() => layoutTimeline(events, view, filter), [events, view, filter])
  const layoutRef = useRef<TimelineLayout>(layout)
  layoutRef.current = layout

  const ix = useTimelineInteractions({
    wrapRef,
    view,
    setView,
    onZoom: changeZoom,
    duration,
    height,
    layoutRef,
    clips,
    seekBefore,
    currentTime,
    getPlayTime,
    playing,
    onSeek,
    onSelectEvent,
    onToggleSelect,
    projectItem,
    onProjectTrim,
    onScrubStart,
    onScrubEnd,
    onHoverSeek,
    bladeMode,
    onBladeModeChange,
    onBladeRange,
    onBladeTooShort,
    disabled,
    onUpdateClip,
    onClipTrimCommit,
    onAutoScroll: (update) => setZoomState((state) => ({ ...state, view: update(state.view) }))
  })

  const following = !ix.interacting && ix.blade.hover === null
  const followPlayhead = useCallback((state: TimelineZoom): TimelineZoom => {
    const time = playheadTarget(playback.current)
    if (state.mode === 'detail') {
      const next = setZoomMode(state, 'detail', time)
      // Ignore sub-pixel steps: each new view rerenders and repaints the canvas, at the display refresh rate during playback.
      const subPixel = next.mode === state.mode && next.view.span === state.view.span &&
        Math.abs(next.view.start - state.view.start) * state.view.width < state.view.span
      return subPixel ? state : next
    }
    if (followProject && state.mode === 'custom' && (time < state.view.start || time >= state.view.start + state.view.span)) {
      return setZoomMode(state, 'custom', time)
    }
    return state
  }, [followProject])

  // Move the detail window with seeks/the playhead; read live time during playback to avoid lagging timeupdate events.
  useEffect(() => {
    if (!following) return
    setZoomState(followPlayhead)
  }, [mode, currentTime, playing, following, followPlayhead])
  const hasPlayTime = !!getPlayTime
  useEffect(() => {
    if ((mode !== 'detail' && !(mode === 'custom' && followProject)) || !playing || !hasPlayTime || !following) return
    let id = 0
    // Pixel-paced timer, not rAF, for the same reason as the playhead loop.
    const tick = (): void => {
      setZoomState(followPlayhead)
      id = window.setTimeout(tick, playbackPollMs(viewRef.current))
    }
    id = window.setTimeout(tick, playbackPollMs(viewRef.current))
    return () => window.clearTimeout(id)
  }, [mode, playing, hasPlayTime, following, followProject, followPlayhead])

  // Low-performance mode (settings update immediately): reduce the heat bar to 60 bins and redraw.
  const lowPerf = useSyncExternalStore(subscribeLowPerf, isLowPerf, isLowPerf)
  const modelRef = useRef<DrawModel | null>(null)
  modelRef.current = {
    width: view.width,
    height,
    view,
    duration,
    layout,
    spectating,
    rounds,
    clips,
    selected,
    currentId: currentEventId,
    hoverClipId: ix.hoverClipId,
    activeClipId,
    lowPerf,
    projectItem: showProjectRange ? projectItem : null,
    blade: ix.blade
  }

  const paint = useCallback((): void => {
    const canvas = canvasRef.current
    const m = modelRef.current
    if (!canvas || !m || m.width <= 0) return
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1)
    const pw = Math.round(m.width * dpr)
    const ph = Math.round(m.height * dpr)
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw
      canvas.height = ph
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    drawTimeline(ctx, m, readTheme())
  }, [])

  const scheduler = useMemo(() => createRedrawScheduler(paint), [paint])
  useEffect(() => () => scheduler.dispose(), [scheduler])
  useEffect(() => {
    const observer = new MutationObserver(() => {
      resetThemeCache()
      scheduler.invalidate()
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [scheduler])

  // Static layer: use rAF to coalesce redraws only when data, zoom, size, selection, or hover changes (not currentTime).
  useEffect(() => {
    scheduler.invalidate()
  }, [scheduler, view, layout, spectating, rounds, clips, selected, currentEventId, ix.hoverClipId, activeClipId, height, lowPerf, projectItem, showProjectRange, ix.blade])

  return (
    <div className="tl-source" data-zone="src">
      <div className="tl-toolbar" role="toolbar" aria-label={i18n.timeline.zoomToolbar}>
        {(['full', 'detail', 'custom'] as const).map((value) => (
          <button
            key={value}
            type="button"
            className="tl-mode"
            aria-pressed={mode === value}
            title={i18n.timeline.zoomTips[value]}
            onClick={() => changeMode(value)}
          >
            {i18n.timeline.zoomModes[value]}
          </button>
        ))}
        <input
          className="tl-custom-zoom"
          type="range"
          min={0}
          max={Math.log2(maxCustomZoom(view.duration))}
          step="any"
          value={Math.log2(customZoom)}
          aria-label={i18n.timeline.customZoom}
          aria-valuetext={`${customZoom.toFixed(1)}×`}
          title={i18n.timeline.zoomTips.custom}
          onChange={(e) => {
            const multiplier = 2 ** Number(e.currentTarget.value)
            setZoomState((state) => setCustomZoom(state, multiplier, playheadTarget(playback.current)))
          }}
        />
      </div>
      <div
        id={canvasId}
        ref={wrapRef}
        className="tl-wrap"
        data-zone="src"
        tabIndex={0}
        style={{ height, cursor: ix.cursor }}
        onMouseDown={ix.onMouseDown}
        onMouseMove={ix.onMouseMove}
        onMouseLeave={ix.onMouseLeave}
      >
        <canvas ref={canvasRef} />
        <Playhead time={currentTime} view={view} getTime={getPlayTime} playing={playing} />
        {ix.tip && (
          <div className="tl-tip" style={{ left: ix.tip.x, top: ix.tip.y }}>
            {ix.tip.text}
          </div>
        )}
      </div>
      <TimelineScrollbar view={view} controls={canvasId} onScroll={(start) => setView((v) => pan(v, start - v.start))} />
    </div>
  )
})
