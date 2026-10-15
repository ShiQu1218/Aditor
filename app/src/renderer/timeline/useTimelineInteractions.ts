import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, MutableRefObject, RefObject } from 'react'
import type { Clip, EngineEvent, EventType } from '../../shared/types'
import { isCounted } from '../../shared/types'
import { formatTime } from '../../shared/time'
import { i18n } from '../i18n/zh-TW'
import { resizeClip } from './clips'
import { EVENT_TOP } from './draw'
import { TimelineLayout, zoomToCluster } from './layout'
import { View, pan, timeToX, xToTime, zoom } from './model'
import { boxSelect, hitItem } from './select'

/** 拖曳超過此距離（px，水平）才視為框選 */
export const DRAG_THRESHOLD_PX = 4
/** 片段把手命中區 ±7 px */
export const HANDLE_HIT_PX = 7
/** 事件／群集命中區（水平）與垂直範圍 */
export const ITEM_HIT_PX = 13
export const ITEM_HIT_Y: [number, number] = [28, 100]

export interface HandleRef {
  clipId: string
  edge: 'start' | 'end'
}

export interface IState {
  phase: 'idle' | 'pressed' | 'box' | 'pan' | 'handle'
  x0: number
  y0: number
  shift: boolean
  handle?: HandleRef
}
export type IAction =
  | { type: 'down'; x: number; y: number; button: number; shift: boolean; space: boolean; handle?: HandleRef | null }
  | { type: 'move'; x: number; y: number }
  | { type: 'up'; x: number; y: number }
  | { type: 'cancel' }
export type IOutcome = 'click' | 'box' | 'pan' | 'handle' | null

export const initialInteraction: IState = { phase: 'idle', x0: 0, y0: 0, shift: false }

/**
 * 滑鼠互動狀態機（純函式）。優先序：Space／中鍵平移 > 片段把手 > 一般按下（click 或框選）。
 * 框選門檻：水平位移 >4 px；一旦成為框選就不會因游標回到起點而退回 click。
 */
export function interactionReducer(s: IState, a: IAction): { state: IState; outcome: IOutcome } {
  switch (a.type) {
    case 'down': {
      const base = { x0: a.x, y0: a.y, shift: a.shift }
      if (a.button === 1 || a.space) return { state: { ...base, phase: 'pan' }, outcome: null }
      if (a.handle) return { state: { ...base, phase: 'handle', handle: a.handle }, outcome: null }
      return { state: { ...base, phase: 'pressed' }, outcome: null }
    }
    case 'move':
      if (s.phase === 'pressed' && Math.abs(a.x - s.x0) > DRAG_THRESHOLD_PX) {
        return { state: { ...s, phase: 'box' }, outcome: null }
      }
      return { state: s, outcome: null }
    case 'up': {
      if (s.phase === 'idle') return { state: s, outcome: null }
      const outcome: IOutcome =
        s.phase === 'pressed' ? 'click' : s.phase === 'box' ? 'box' : s.phase === 'pan' ? 'pan' : 'handle'
      return { state: initialInteraction, outcome }
    }
    case 'cancel':
      return { state: initialInteraction, outcome: null }
  }
}

/* ---------------- 命中測試（純函式） ---------------- */

/** 片段把手：邊緣 ±7 px、y 位於框區內；多個命中取最近者 */
export function handleAt(clips: Clip[], view: View, mx: number, my: number, height: number): HandleRef | null {
  if (my < EVENT_TOP - 2 || my > height - 4) return null
  let best: HandleRef | null = null
  let bestD = HANDLE_HIT_PX + 1
  for (const c of clips) {
    if (c.status === 'skipped') continue
    const ds = Math.abs(timeToX(c.start, view) - mx)
    const de = Math.abs(timeToX(c.end, view) - mx)
    if (ds <= HANDLE_HIT_PX && ds < bestD) {
      best = { clipId: c.id, edge: 'start' }
      bestD = ds
    }
    if (de <= HANDLE_HIT_PX && de < bestD) {
      best = { clipId: c.id, edge: 'end' }
      bestD = de
    }
  }
  return best
}

export function clipAt(clips: Clip[], view: View, mx: number, my: number): Clip | null {
  if (my <= EVENT_TOP - 2) return null
  return (
    clips.find(
      (c) =>
        c.status !== 'skipped' &&
        mx >= timeToX(c.start, view) - HANDLE_HIT_PX &&
        mx <= timeToX(c.end, view) + HANDLE_HIT_PX
    ) ?? null
  )
}

function eventTip(e: EngineEvent): string {
  const tl = i18n.timeline
  const type = (tl.types as Record<string, string>)[e.type] ?? e.type
  let state: string
  if (isCounted(e)) state = tl.counted
  else {
    const why =
      e.counted_override === false ? tl.forced : ((tl.reasons as Record<string, string>)[e.counted_reason] ?? e.counted_reason)
    state = `${tl.uncounted}（${why}）`
  }
  return `${type} · ${formatTime(e.t)} · ${state}`
}

export function tooltipAt(layout: TimelineLayout, mx: number, my: number): string | null {
  if (my < ITEM_HIT_Y[0] || my > ITEM_HIT_Y[1]) return null
  const tl = i18n.timeline
  if (layout.mode === 'density') {
    const near = layout.items.filter((it) => Math.abs(it.x - mx) <= 6).map((it) => it.events[0])
    if (near.length === 0) return null
    return tl.densityTip
      .replace('{n}', String(near.length))
      .replace('{time}', formatTime(near[0].t))
      .replace('{c}', String(near.filter(isCounted).length))
  }
  const hit = hitItem(layout.items, mx, ITEM_HIT_PX)
  if (!hit) return null
  if (hit.events.length === 1) return eventTip(hit.events[0])
  return tl.clusterTip
    .replace('{n}', String(hit.events.length))
    .replace('{from}', formatTime(hit.events[0].t))
    .replace('{to}', formatTime(hit.events[hit.events.length - 1].t))
}

/* ---------------- Hook ---------------- */

export interface InteractionOptions {
  wrapRef: RefObject<HTMLDivElement>
  view: View
  setView: (fn: (v: View) => View) => void
  duration: number
  height: number
  layoutRef: MutableRefObject<TimelineLayout>
  clips: Clip[]
  events: EngineEvent[]
  filter: Set<EventType>
  /** 點事件圖示 seek 到 t - seekBefore（秒） */
  seekBefore: number
  onSeek: (t: number) => void
  onSelectEvent?: (e: EngineEvent) => void
  onToggleSelect?: (id: string) => void
  onBoxSelect?: (ids: string[], t1: number, t2: number, additive: boolean) => void
  onUpdateClip?: (clip: Clip) => void
}

export interface InteractionResult {
  onMouseDown: (e: ReactMouseEvent<HTMLElement>) => void
  onMouseMove: (e: ReactMouseEvent<HTMLElement>) => void
  onMouseLeave: () => void
  box: { x0: number; x1: number } | null
  hoverClipId: string | null
  cursor: string
  tip: { x: number; y: number; text: string } | null
}

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || !el.tagName) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
}

export function useTimelineInteractions(opts: InteractionOptions): InteractionResult {
  const o = useRef(opts)
  o.current = opts

  const st = useRef<IState>(initialInteraction)
  const panStart = useRef<{ clientX: number; start: number } | null>(null)
  const downT = useRef(0)
  const spaceRef = useRef(false)
  const insideRef = useRef(false)

  const [box, setBox] = useState<{ x0: number; x1: number } | null>(null)
  const [hoverClipId, setHoverClipId] = useState<string | null>(null)
  const [cursor, setCursor] = useState('pointer')
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null)

  const local = useCallback((clientX: number, clientY: number): { x: number; y: number } => {
    const r = o.current.wrapRef.current?.getBoundingClientRect()
    return r ? { x: clientX - r.left, y: clientY - r.top } : { x: 0, y: 0 }
  }, [])

  const apply = useCallback((a: IAction): IOutcome => {
    const r = interactionReducer(st.current, a)
    st.current = r.state
    return r.outcome
  }, [])

  const onMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLElement>) => {
      if (e.button !== 0 && e.button !== 1) return
      const { x, y } = local(e.clientX, e.clientY)
      const cur = o.current
      const handle = handleAt(cur.clips, cur.view, x, y, cur.height)
      apply({ type: 'down', x, y, button: e.button, shift: e.shiftKey || e.ctrlKey, space: spaceRef.current, handle })
      downT.current = xToTime(x, cur.view)
      if (st.current.phase === 'pan') {
        e.preventDefault()
        panStart.current = { clientX: e.clientX, start: cur.view.start }
        setCursor('grabbing')
      } else if (st.current.phase === 'handle') {
        setCursor('ew-resize')
      }
      setTip(null)
      o.current.wrapRef.current?.focus()
    },
    [apply, local]
  )

  // 拖曳中的移動與放開掛在 window，游標離開時間軸也不中斷
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (st.current.phase === 'idle') return
      const { x, y } = local(e.clientX, e.clientY)
      apply({ type: 'move', x, y })
      const cur = o.current
      const s = st.current
      if (s.phase === 'pan' && panStart.current) {
        const dt = ((panStart.current.clientX - e.clientX) / Math.max(1, cur.view.width)) * cur.view.span
        const target = panStart.current.start + dt
        cur.setView((v) => pan(v, target - v.start))
      } else if (s.phase === 'handle' && s.handle && cur.onUpdateClip) {
        const clip = cur.clips.find((c) => c.id === s.handle!.clipId)
        if (clip) cur.onUpdateClip(resizeClip(clip, s.handle.edge, xToTime(x, cur.view), cur.duration))
      } else if (s.phase === 'box') {
        setBox({ x0: s.x0, x1: x })
      }
    }
    const onUp = (e: MouseEvent): void => {
      if (st.current.phase === 'idle') return
      const { x, y } = local(e.clientX, e.clientY)
      const s = st.current
      const outcome = apply({ type: 'up', x, y })
      const cur = o.current
      setBox(null)
      panStart.current = null
      setCursor(spaceRef.current ? 'grab' : 'pointer')
      if (outcome === 'box') {
        const t1 = Math.min(downT.current, xToTime(x, cur.view))
        const t2 = Math.max(downT.current, xToTime(x, cur.view))
        cur.onBoxSelect?.(boxSelect(cur.events, t1, t2, cur.filter), t1, t2, s.shift)
      } else if (outcome === 'click') {
        const L = cur.layoutRef.current
        const inZone = s.y0 >= ITEM_HIT_Y[0] && s.y0 <= ITEM_HIT_Y[1]
        const hit = L.mode === 'icons' && inZone ? hitItem(L.items, s.x0, ITEM_HIT_PX) : null
        if (hit && hit.events.length === 1) {
          const ev = hit.events[0]
          if (s.shift) cur.onToggleSelect?.(ev.id)
          else if (cur.onSelectEvent) cur.onSelectEvent(ev)
          else cur.onSeek(Math.max(0, ev.t - cur.seekBefore))
        } else if (hit) {
          cur.setView((v) => zoomToCluster(hit, v))
        } else {
          cur.onSeek(Math.max(0, Math.min(cur.duration, xToTime(s.x0, cur.view))))
        }
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [apply, local])

  // Space 平移的游標回饋（播放／暫停仍由全域鍵盤層處理）
  useEffect(() => {
    const active = (): boolean => insideRef.current || document.activeElement === o.current.wrapRef.current
    const down = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' || isTypingTarget(e.target) || !active()) return
      spaceRef.current = true
      if (st.current.phase === 'idle') setCursor('grab')
    }
    const up = (e: KeyboardEvent): void => {
      if (e.code !== 'Space') return
      spaceRef.current = false
      if (st.current.phase === 'idle') setCursor('pointer')
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  // 滾輪：Ctrl＝縮放（錨點為游標）；已放大時＝平移。需 passive:false 才能 preventDefault
  useEffect(() => {
    const el = opts.wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      const cur = o.current
      const { x } = local(e.clientX, e.clientY)
      if (e.ctrlKey) {
        e.preventDefault()
        const anchor = xToTime(x, cur.view)
        cur.setView((v) => zoom(v, e.deltaY < 0 ? 0.7 : 1.4, anchor))
      } else if (cur.view.span < cur.view.duration) {
        e.preventDefault()
        const dt = (e.deltaY / 100) * cur.view.span * 0.15
        cur.setView((v) => pan(v, dt))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [opts.wrapRef, local])

  const onMouseMove = useCallback(
    (e: ReactMouseEvent<HTMLElement>) => {
      insideRef.current = true
      if (st.current.phase !== 'idle') return
      const { x, y } = local(e.clientX, e.clientY)
      const cur = o.current
      const clip = clipAt(cur.clips, cur.view, x, y)
      setHoverClipId(clip ? clip.id : null)
      const handle = handleAt(cur.clips, cur.view, x, y, cur.height)
      setCursor(spaceRef.current ? 'grab' : handle ? 'ew-resize' : 'pointer')
      const text = tooltipAt(cur.layoutRef.current, x, y)
      setTip(text ? { x: Math.min(x + 10, Math.max(0, cur.view.width - 260)), y: Math.max(y - 34, 24), text } : null)
    },
    [local]
  )

  const onMouseLeave = useCallback(() => {
    insideRef.current = false
    if (st.current.phase === 'idle') {
      setHoverClipId(null)
      setTip(null)
    }
  }, [])

  return { onMouseDown, onMouseMove, onMouseLeave, box, hoverClipId, cursor, tip }
}
