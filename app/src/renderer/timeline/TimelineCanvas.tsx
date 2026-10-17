import React, { useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { isLowPerf, subscribeLowPerf } from '../perf/lowPerf'
import '../styles/timeline.css'
import { Clip, EngineEvent, EventType, SpecInterval } from '../../shared/types'
import { View, TimelineZoom, ZoomMode, maxCustomZoom, pan, resizeTimeline, setCustomZoom, setZoomMode, updateTimelineView, zoomTimeline } from './model'
import { i18n } from '../i18n/zh-TW'
import { layoutTimeline, TimelineLayout } from './layout'
import { createRedrawScheduler, DrawModel, drawTimeline, readTheme, resetThemeCache } from './draw'
import { Playhead, playheadTarget } from './Playhead'
import { TimelineScrollbar } from './TimelineScrollbar'
import { useTimelineInteractions, type InteractionOptions } from './useTimelineInteractions'

/** 命令式時間軸操作（keymap 的 Ctrl +/−/0 由外層呼叫）。 */
export interface TimelineHandle {
  zoomIn: () => void
  zoomOut: () => void
  zoomReset: () => void
}

interface TimelineCanvasProps extends Pick<InteractionOptions,
  'projectItem' | 'onProjectTrim' | 'onScrubStart' | 'onScrubEnd' | 'onHoverSeek' |
  'bladeMode' | 'onBladeModeChange' | 'onBladeRange' | 'onBladeTooShort' | 'disabled'> {
  duration: number
  currentTime: number
  events: EngineEvent[]
  spectating: SpecInterval[]
  clips: Clip[]
  filter: Set<EventType>
  onSeek: (t: number) => void
  onSelectEvent?: (e: EngineEvent) => void
  onUpdateClip?: (clip: Clip) => void
  /* 以下為新增的可選 props */
  height?: number
  selected?: Set<string>
  /** 目前播放位置所在事件（畫外環） */
  currentEventId?: string
  activeClipId?: string | null
  /** 點事件圖示時 seek 到 t - seekBefore（預設 8 秒；僅在未提供 onSelectEvent 時使用） */
  seekBefore?: number
  onToggleSelect?: (id: string) => void
  /** 播放中以 rAF 讀取目前時間（例如 video.currentTime），播放頭不經 React 重繪 */
  getPlayTime?: () => number
  playing?: boolean
  /** 專案預覽時，自訂縮放也要讓來源播放頭保持可見。 */
  followProject?: boolean
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
  // 自訂縮放一律以播放頭為中心（滾輪、按鈕、快捷鍵、倍率滑桿）
  const changeZoom = useCallback((factor: number): void => {
    setZoomState((state) => zoomTimeline(state, factor, playheadTarget(playback.current)))
  }, [])

  // 時長改變時保留模式與自訂倍率，並夾在新來源範圍內
  useEffect(() => {
    setZoomState((state) => resizeTimeline(state, duration, state.view.width, playheadTarget(playback.current)))
  }, [duration])

  // 寬度：ResizeObserver
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

  // 命令式縮放（keymap 的 Ctrl +/−/0）：以播放頭為中心
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
    onAutoScroll: (update) => setZoomState((state) => ({ ...state, view: update(state.view) }))
  })

  const following = !ix.interacting && ix.blade.hover === null
  const followPlayhead = useCallback((state: TimelineZoom): TimelineZoom => {
    const time = playheadTarget(playback.current)
    if (state.mode === 'detail') return setZoomMode(state, 'detail', time)
    if (followProject && state.mode === 'custom' && (time < state.view.start || time >= state.view.start + state.view.span)) {
      return setZoomMode(state, 'custom', time)
    }
    return state
  }, [followProject])

  // 細節視窗隨 seek／播放頭移動；播放時直接讀即時時間，避免 timeupdate 落後
  useEffect(() => {
    if (!following) return
    setZoomState(followPlayhead)
  }, [mode, currentTime, playing, following, followPlayhead])
  const hasPlayTime = !!getPlayTime
  useEffect(() => {
    if ((mode !== 'detail' && !(mode === 'custom' && followProject)) || !playing || !hasPlayTime || !following) return
    let id = 0
    const tick = (): void => {
      setZoomState(followPlayhead)
      id = requestAnimationFrame(tick)
    }
    id = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(id)
  }, [mode, playing, hasPlayTime, following, followProject, followPlayhead])

  // 低效能模式（設定即時切換）：熱度條降為 60 格並重繪
  const lowPerf = useSyncExternalStore(subscribeLowPerf, isLowPerf, isLowPerf)
  const modelRef = useRef<DrawModel | null>(null)
  modelRef.current = {
    width: view.width,
    height,
    view,
    duration,
    layout,
    spectating,
    clips,
    selected,
    currentId: currentEventId,
    hoverClipId: ix.hoverClipId,
    activeClipId,
    lowPerf,
    projectItem,
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

  // 靜態層：只在資料／縮放／尺寸／選取／hover 改變時以 rAF 合併重繪（currentTime 不在其中）
  useEffect(() => {
    scheduler.invalidate()
  }, [scheduler, view, layout, spectating, clips, selected, currentEventId, ix.hoverClipId, activeClipId, height, lowPerf, projectItem, ix.blade])

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
