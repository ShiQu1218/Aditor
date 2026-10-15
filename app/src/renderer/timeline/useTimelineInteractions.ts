import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, MutableRefObject, RefObject } from 'react'
import type { Clip, EngineEvent, EventType } from '../../shared/types'
import { isCounted } from '../../shared/types'
import { formatTime } from '../../shared/time'
import { i18n } from '../i18n/zh-TW'
import { targetKindOf } from '../input/focusZone'
import { resizeClip } from './clips'
import { EVENT_TOP } from './draw'
import { TimelineLayout, zoomToCluster } from './layout'
import { View, pan, timeToX, xToTime, zoom } from './model'
import { boxSelect, hitDensity, hitItem } from './select'
import { idleArbiter, spaceArbiter, type SpaceArbiter } from './spacePlay'

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

export type CancelEvent = { type: 'move'; buttons: number } | { type: 'blur' } | { type: 'escape' }

/** 手勢是否應被取消：視窗失焦、Esc、或 move 時已沒有按下任何滑鼠鍵（mouseup 發生在視窗外而遺失；正常 mouseup 的 buttons 本就為 0，故不在 up 判斷） */
export function shouldCancel(phase: IState['phase'], ev: CancelEvent): boolean {
  if (phase === 'idle') return false
  if (ev.type === 'blur' || ev.type === 'escape') return true
  return ev.buttons === 0
}

/** Esc 取消了進行中的手勢時，該次 Esc 不得再傳給全域快捷鍵（否則會一併離開專案模式／清除選取） */
export function swallowEscape(phase: IState['phase']): boolean {
  return phase !== 'idle'
}

/**
 * 以捕獲階段監聽 Esc：僅在確實有手勢可取消時才 preventDefault＋stopPropagation，
 * 其餘情況原樣放行。輸入法組字中的 Escape（isComposing／keyCode 229）不取消手勢、不攔截。
 * 回傳解除函式。
 */
export function attachGestureEscape(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  getPhase: () => IState['phase'],
  cancel: () => void
): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if (e.isComposing || e.keyCode === 229) return
    if (e.key !== 'Escape' || !swallowEscape(getPhase())) return
    cancel()
    e.preventDefault()
    e.stopPropagation()
  }
  target.addEventListener('keydown', onKey as EventListener, true)
  return () => target.removeEventListener('keydown', onKey as EventListener, true)
}

/** 取消時需還原的片段（把手拖曳中途取消＝片段維持原樣） */
export function cancelRestore(s: IState, original: Clip | null): Clip | null {
  return s.phase === 'handle' && original ? original : null
}

/** 指標座標→軌內 x（容許元素被 CSS 縮放：rect.width 與邏輯寬 view.width 不同時換算） */
export function pointerToX(clientX: number, rectLeft: number, rectWidth: number, viewWidth: number): number {
  const scale = rectWidth > 0 ? viewWidth / rectWidth : 1
  return (clientX - rectLeft) * scale
}

/** tooltip 狀態是否需要更新（文字或取整後位置改變才更新，避免 60 Hz 重繪） */
export function tipChanged(
  a: { x: number; y: number; text: string } | null,
  b: { x: number; y: number; text: string } | null
): boolean {
  if (a === b) return false
  if (!a || !b) return true
  return a.text !== b.text || Math.round(a.x) !== Math.round(b.x) || Math.round(a.y) !== Math.round(b.y)
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
    const near = hitDensity(layout.items, mx, 6)
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
  /** 空白鍵輕按（放開時未平移）＝切換播放；由 spaceArbiter 仲裁後呼叫 */
  onPlayToggle?: () => void
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

export function useTimelineInteractions(opts: InteractionOptions): InteractionResult {
  const o = useRef(opts)
  o.current = opts

  const st = useRef<IState>(initialInteraction)
  const panStart = useRef<{ clientX: number; start: number } | null>(null)
  const downT = useRef(0)
  const arbRef = useRef<SpaceArbiter>(idleArbiter)
  const originalClip = useRef<Clip | null>(null)
  const insideRef = useRef(false)

  const [box, setBox] = useState<{ x0: number; x1: number } | null>(null)
  const [hoverClipId, setHoverClipId] = useState<string | null>(null)
  const [cursor, setCursor] = useState('pointer')
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null)

  const local = useCallback((clientX: number, clientY: number): { x: number; y: number } => {
    const r = o.current.wrapRef.current?.getBoundingClientRect()
    return r
      ? { x: pointerToX(clientX, r.left, r.width, o.current.view.width), y: clientY - r.top }
      : { x: 0, y: 0 }
  }, [])

  /** 空白鍵是否讓時間軸處於「平移待命」或已平移（游標回饋用） */
  const spaceHeld = (): boolean => arbRef.current.pending || arbRef.current.panned

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
      // 空白鍵仲裁：按住 >200 ms 後才視為平移；未達門檻的按下不觸發播放
      const gate = spaceArbiter(arbRef.current, { type: 'pointerdown', now: performance.now() })
      arbRef.current = gate.state
      const handle = handleAt(cur.clips, cur.view, x, y, cur.height)
      apply({ type: 'down', x, y, button: e.button, shift: e.shiftKey || e.ctrlKey, space: gate.pan, handle })
      downT.current = xToTime(x, cur.view)
      originalClip.current = handle ? (cur.clips.find((c) => c.id === handle.clipId) ?? null) : null
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
    const cancelGesture = (): void => {
      const restore = cancelRestore(st.current, originalClip.current)
      apply({ type: 'cancel' })
      originalClip.current = null
      panStart.current = null
      setBox(null)
      setCursor(spaceHeld() ? 'grab' : 'pointer')
      if (restore) o.current.onUpdateClip?.(restore)
    }
    const onMove = (e: MouseEvent): void => {
      if (st.current.phase === 'idle') return
      if (shouldCancel(st.current.phase, { type: 'move', buttons: e.buttons })) return cancelGesture()
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
      setCursor(spaceHeld() ? 'grab' : 'pointer')
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
    const onBlur = (): void => {
      arbRef.current = idleArbiter
      if (shouldCancel(st.current.phase, { type: 'blur' })) cancelGesture()
      else setCursor('pointer')
    }
    const detachEsc = attachGestureEscape(
      window,
      () => (shouldCancel(st.current.phase, { type: 'escape' }) ? st.current.phase : 'idle'),
      cancelGesture
    )
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('blur', onBlur)
      detachEsc()
    }
  }, [apply, local])

  // 空白鍵仲裁（spec §3.2.2）：游標在時間軸內或時間軸聚焦時接管 Space。
  // 輕按＝放開時切換播放（keydown 時 preventDefault 抑制全域 keymap 的 play，keymap 跳過 defaultPrevented）；
  // 按住 >200 ms 後才有資格成為平移（由 onMouseDown 的 pointerdown 仲裁決定），平移不觸發播放。
  useEffect(() => {
    const active = (): boolean => insideRef.current || document.activeElement === o.current.wrapRef.current
    const down = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' || e.isComposing || e.keyCode === 229) return
      // 文字欄位／原生控制項的 Space 保留原生行為
      if (targetKindOf(e.target as HTMLElement | null) !== 'none') return
      if (!active()) return
      const r = spaceArbiter(arbRef.current, { type: 'keydown', now: performance.now() })
      arbRef.current = r.state
      if (!r.state.pending && !r.state.panned) return
      e.preventDefault()
      if (st.current.phase === 'idle') setCursor('grab')
    }
    const up = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' || e.isComposing) return
      const r = spaceArbiter(arbRef.current, { type: 'keyup', now: performance.now() })
      arbRef.current = r.state
      if (r.play) o.current.onPlayToggle?.()
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
      setCursor(spaceHeld() ? 'grab' : handle ? 'ew-resize' : 'pointer')
      const text = tooltipAt(cur.layoutRef.current, x, y)
      const next = text ? { x: Math.min(x + 10, Math.max(0, cur.view.width - 260)), y: Math.max(y - 34, 24), text } : null
      setTip((prev) => (tipChanged(prev, next) ? next : prev))
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
