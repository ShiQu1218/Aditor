import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { isLowPerf, subscribeLowPerf } from '../perf/lowPerf'
import '../styles/timeline.css'
import { Clip, EngineEvent, EventType, SpecInterval } from '../../shared/types'
import { View, zoom } from './model'
import { layoutTimeline, TimelineLayout } from './layout'
import { createRedrawScheduler, DrawModel, drawTimeline, readTheme } from './draw'
import { Playhead } from './Playhead'
import { useTimelineInteractions } from './useTimelineInteractions'

/** 命令式時間軸操作（keymap 的 Ctrl +/−/0 由外層呼叫）。 */
export interface TimelineHandle {
  zoomIn: () => void
  zoomOut: () => void
  zoomReset: () => void
}

interface TimelineCanvasProps {
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
  onBoxSelect?: (ids: string[], t1: number, t2: number, additive: boolean) => void
  /** 播放中以 rAF 讀取目前時間（例如 video.currentTime），播放頭不經 React 重繪 */
  getPlayTime?: () => number
  playing?: boolean
  /** 空白鍵輕按（未平移）＝切換播放 */
  onPlayToggle?: () => void
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
    onBoxSelect,
    getPlayTime,
    playing,
    onPlayToggle
  }: TimelineCanvasProps,
  ref
): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const [view, setView] = useState<View>(() => ({
    duration: Math.max(1, duration),
    start: 0,
    span: Math.max(1, duration),
    width: 800
  }))

  // 時長改變：原本是完整檢視者跟著新時長，否則夾在範圍內
  useEffect(() => {
    const d = Math.max(1, duration)
    setView((v) => {
      if (v.duration === d) return v
      const full = v.span >= v.duration - 1e-6
      const span = full ? d : Math.min(d, v.span)
      return { ...v, duration: d, span, start: Math.max(0, Math.min(d - span, v.start)) }
    })
  }, [duration])

  // 寬度：ResizeObserver
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const update = (): void => {
      const w = el.clientWidth
      setView((v) => (v.width === w ? v : { ...v, width: w }))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 命令式縮放（keymap 的 Ctrl +/−/0）：錨點為目前視窗中心
  useImperativeHandle(
    ref,
    () => ({
      zoomIn: () => setView((v) => zoom(v, ZOOM_IN_FACTOR, v.start + v.span / 2)),
      zoomOut: () => setView((v) => zoom(v, ZOOM_OUT_FACTOR, v.start + v.span / 2)),
      zoomReset: () => setView((v) => ({ ...v, start: 0, span: v.duration }))
    }),
    []
  )

  const layout = useMemo(() => layoutTimeline(events, view, filter), [events, view, filter])
  const layoutRef = useRef<TimelineLayout>(layout)
  layoutRef.current = layout

  const ix = useTimelineInteractions({
    wrapRef,
    view,
    setView,
    duration,
    height,
    layoutRef,
    clips,
    events,
    filter,
    seekBefore,
    onSeek,
    onSelectEvent,
    onToggleSelect,
    onBoxSelect,
    onUpdateClip,
    onPlayToggle
  })

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
    lowPerf
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

  // 靜態層：只在資料／縮放／尺寸／選取／hover 改變時以 rAF 合併重繪（currentTime 不在其中）
  useEffect(() => {
    scheduler.invalidate()
  }, [scheduler, view, layout, spectating, clips, selected, currentEventId, ix.hoverClipId, activeClipId, height, lowPerf])

  return (
    <div
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
      {ix.box && (
        <div
          className="tl-boxsel"
          style={{ left: Math.min(ix.box.x0, ix.box.x1), width: Math.abs(ix.box.x1 - ix.box.x0) }}
        />
      )}
      {ix.tip && (
        <div className="tl-tip" style={{ left: ix.tip.x, top: ix.tip.y }}>
          {ix.tip.text}
        </div>
      )}
    </div>
  )
})
