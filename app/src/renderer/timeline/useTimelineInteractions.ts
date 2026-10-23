import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, MutableRefObject, RefObject } from 'react'
import type { Clip, EngineEvent } from '../../shared/types'
import { isCounted } from '../../shared/types'
import { formatTime } from '../../shared/time'
import { i18n } from '../i18n'
import { resizeClip } from './clips'
import { EVENT_TOP } from './draw'
import { TimelineLayout, zoomToCluster } from './layout'
import { View, pan, timeToX, xToTime, zoom } from './model'
import { hitDensity, hitItem } from './select'
import { playheadTarget } from './Playhead'
import { bladeReducer, initialBlade, type BladeAction, type BladeState } from './blade'
import type { ProjectItem } from '../editor/project'
import { tr } from '../../shared/locale'

/** Horizontal drag distance in px required to count as dragging the playhead. */
export const DRAG_THRESHOLD_PX = 4
/** Clip-handle hit area: ±7 px. */
export const HANDLE_HIT_PX = 7
/** Horizontal event/cluster hit area and vertical range. */
export const ITEM_HIT_PX = 13
export const ITEM_HIT_Y: [number, number] = [28, 100]

export interface HandleRef {
  clipId: string
  edge: 'start' | 'end'
  project?: boolean
}

export interface IState {
  phase: 'idle' | 'pressed' | 'scrub' | 'pan' | 'handle'
  x0: number
  y0: number
  shift: boolean
  handle?: HandleRef
}
export type IAction =
  | { type: 'down'; x: number; y: number; button: number; shift: boolean; playhead?: boolean; handle?: HandleRef | null }
  | { type: 'move'; x: number; y: number }
  | { type: 'up'; x: number; y: number }
  | { type: 'cancel' }
export type IOutcome = 'click' | 'scrub' | 'pan' | 'handle' | null

export const initialInteraction: IState = { phase: 'idle', x0: 0, y0: 0, shift: false }

/**
 * Mouse interaction state machine (pure function). Priority: middle-button pan > playhead > clip handle > regular press (click or scrub).
 * Drag threshold: horizontal movement >4 px; once scrubbing starts, it never reverts to a click.
 */
export function interactionReducer(s: IState, a: IAction): { state: IState; outcome: IOutcome } {
  switch (a.type) {
    case 'down': {
      const base = { x0: a.x, y0: a.y, shift: a.shift }
      if (a.button !== 0 && a.button !== 1) return { state: s, outcome: null }
      if (a.button === 1) return { state: { ...base, phase: 'pan' }, outcome: null }
      if (a.playhead) return { state: { ...base, phase: 'scrub' }, outcome: null }
      if (a.handle) return { state: { ...base, phase: 'handle', handle: a.handle }, outcome: null }
      return { state: { ...base, phase: 'pressed' }, outcome: null }
    }
    case 'move':
      if (s.phase === 'pressed' && Math.abs(a.x - s.x0) > DRAG_THRESHOLD_PX) {
        return { state: { ...s, phase: 'scrub' }, outcome: null }
      }
      return { state: s, outcome: null }
    case 'up': {
      if (s.phase === 'idle') return { state: s, outcome: null }
      const outcome: IOutcome =
        s.phase === 'pressed' ? 'click' : s.phase === 'scrub' ? 'scrub' : s.phase === 'pan' ? 'pan' : 'handle'
      return { state: initialInteraction, outcome }
    }
    case 'cancel':
      return { state: initialInteraction, outcome: null }
  }
}

export type CancelEvent = { type: 'move'; buttons: number } | { type: 'blur' } | { type: 'escape' }

/** Whether to cancel a gesture: window blur, Esc, or move with no mouse buttons held (mouseup may have been lost outside the window; normal mouseup has buttons=0, so it is not checked on up). */
export function shouldCancel(phase: IState['phase'], ev: CancelEvent): boolean {
  if (phase === 'idle') return false
  if (ev.type === 'blur' || ev.type === 'escape') return true
  return ev.buttons === 0
}

/** When Esc cancels an active gesture, do not pass it to global shortcuts (which could also exit project mode or clear the selection). */
export function swallowEscape(phase: IState['phase']): boolean {
  return phase !== 'idle'
}

/**
 * Listen for Esc during capture: call preventDefault and stopPropagation only when there is an active gesture to cancel;
 * otherwise let the event pass through. Escape during IME composition (isComposing/keyCode 229) neither cancels nor gets intercepted.
 * Returns a cleanup function.
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

/** Clip state to restore on cancellation (canceling a handle drag keeps the clip unchanged). */
export function cancelRestore(s: IState, original: Clip | null): Clip | null {
  return s.phase === 'handle' && original ? original : null
}

/** Convert pointer coordinates to timeline x (account for CSS scaling when rect.width differs from logical view.width). */
export function pointerToX(clientX: number, rectLeft: number, rectWidth: number, viewWidth: number): number {
  const scale = rectWidth > 0 ? viewWidth / rectWidth : 1
  return (clientX - rectLeft) * scale
}

/** Whether tooltip state needs updating (update only when text or rounded position changes to avoid 60 Hz rerenders). */
export function tipChanged(
  a: { x: number; y: number; text: string } | null,
  b: { x: number; y: number; text: string } | null
): boolean {
  if (a === b) return false
  if (!a || !b) return true
  return a.text !== b.text || Math.round(a.x) !== Math.round(b.x) || Math.round(a.y) !== Math.round(b.y)
}

/* ---------------- Hit testing (pure functions) ---------------- */

/** Clip handle: ±7 px from the edge and y within the box; if several match, choose the nearest. */
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
    state = tr('{label}（{detail}）', { label: tl.uncounted, detail: why })
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

/** Near either edge, derive scroll speed from the viewport span; do not scroll in overview mode. */
export function scrubAutoPan(view: View, x: number, elapsed = 16): View {
  if (view.width <= 0 || view.span >= view.duration) return view
  const margin = Math.min(36, view.width / 4)
  const speed = x < margin ? -Math.min(1, (margin - x) / margin)
    : x > view.width - margin ? Math.min(1, (x - view.width + margin) / margin) : 0
  return speed === 0 ? view : pan(view, speed * view.span * 0.025 * Math.min(32, elapsed) / 16)
}

export interface InteractionOptions {
  wrapRef: RefObject<HTMLDivElement>
  view: View
  setView: (fn: (v: View) => View) => void
  onAutoScroll: (fn: (v: View) => View) => void
  onZoom?: (factor: number, anchor: number) => void
  duration: number
  height: number
  layoutRef: MutableRefObject<TimelineLayout>
  clips: Clip[]
  projectItem?: ProjectItem | null
  onProjectTrim?: (id: string, edge: 'start' | 'end', t: number, phase: 'preview' | 'commit' | 'cancel') => void
  seekBefore: number
  currentTime: number
  getPlayTime?: () => number
  playing?: boolean
  onSeek: (t: number) => void
  onScrubStart?: () => void
  onScrubEnd?: (cancelled: boolean) => void
  onHoverSeek?: (t: number | null) => void
  bladeMode?: boolean
  onBladeModeChange?: (enabled: boolean) => void
  onBladeRange?: (start: number, end: number) => void
  onBladeTooShort?: () => void
  disabled?: boolean
  onSelectEvent?: (e: EngineEvent) => void
  onToggleSelect?: (id: string) => void
  onUpdateClip?: (clip: Clip) => void
}

export interface InteractionResult {
  onMouseDown: (e: ReactMouseEvent<HTMLElement>) => void
  onMouseMove: (e: ReactMouseEvent<HTMLElement>) => void
  onMouseLeave: () => void
  interacting: boolean
  blade: BladeState
  hoverClipId: string | null
  cursor: string
  tip: { x: number; y: number; text: string } | null
}

export function useTimelineInteractions(opts: InteractionOptions): InteractionResult {
  const o = useRef(opts)
  o.current = opts
  const st = useRef<IState>(initialInteraction)
  const panStart = useRef<{ clientX: number; start: number } | null>(null)
  const originalClip = useRef<Clip | null>(null)
  const scrubStart = useRef<{ time: number; view: View } | null>(null)
  const lastSeek = useRef<number | null>(null)
  const cancelGestureRef = useRef<() => void>(() => undefined)
  const pointer = useRef<{ clientX: number; clientY: number } | null>(null)
  const frame = useRef<number | null>(null)
  const lastFrame = useRef<number | null>(null)
  const bladeRef = useRef(initialBlade)
  const [blade, setBlade] = useState(initialBlade)
  const [interacting, setInteracting] = useState(false)
  const [hoverClipId, setHoverClipId] = useState<string | null>(null)
  const [cursor, setCursor] = useState('pointer')
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null)

  const local = useCallback((clientX: number, clientY: number): { x: number; y: number } => {
    const r = o.current.wrapRef.current?.getBoundingClientRect()
    return r
      ? { x: pointerToX(clientX, r.left, r.width, o.current.view.width), y: clientY - r.top }
      : { x: 0, y: 0 }
  }, [])
  const timeAt = (x: number, view = o.current.view): number =>
    Math.max(0, Math.min(o.current.duration, xToTime(x, view)))

  const apply = useCallback((a: IAction): IOutcome => {
    const r = interactionReducer(st.current, a)
    st.current = r.state
    return r.outcome
  }, [])
  const applyBlade = useCallback((a: BladeAction): void => {
    const r = bladeReducer(bladeRef.current, a)
    bladeRef.current = r.state
    setBlade(r.state)
    if (r.range) o.current.onBladeRange?.(...r.range)
    if (r.tooShort) o.current.onBladeTooShort?.()
  }, [])
  const stopFrame = useCallback((): void => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    lastFrame.current = null
  }, [])
  const beginScrub = useCallback((dragCursor = 'grabbing'): void => {
    if (scrubStart.current) return
    const cur = o.current
    scrubStart.current = {
      time: playheadTarget({ playing: cur.playing, time: cur.currentTime, getTime: cur.getPlayTime }),
      view: cur.view
    }
    lastSeek.current = null
    cur.onScrubStart?.()
    setCursor(dragCursor)
  }, [])
  /** Preview the constrained edge while dragging, then commit at most one project edit on release. */
  const updateHandle = (x: number, phase: 'preview' | 'commit', view = o.current.view): void => {
    const cur = o.current
    const h = st.current.handle
    if (!h) return
    let t = timeAt(x, view)
    if (h.project) {
      const item = cur.projectItem
      if (!item) return
      t = h.edge === 'start' ? Math.max(0, Math.min(t, item.end - 0.1))
        : Math.max(item.start + 0.1, Math.min(t, cur.duration))
      if (phase === 'preview' && t === lastSeek.current) return
      cur.onProjectTrim?.(h.clipId, h.edge, t, phase)
    } else {
      const clip = originalClip.current
      if (!clip) return
      const next = resizeClip(clip, h.edge, t, cur.duration)
      t = h.edge === 'start' ? next.start : next.end
      if (phase === 'preview' && t === lastSeek.current) return
      cur.onUpdateClip?.(next)
    }
    if (scrubStart.current && t !== lastSeek.current) {
      cur.onSeek(t)
      lastSeek.current = t
    }
  }
  const updateHandleRef = useRef(updateHandle)
  updateHandleRef.current = updateHandle

  const projectHandle = (x: number, y: number): HandleRef | null => {
    const cur = o.current
    const item = cur.projectItem
    if (!item) return null
    const hit = handleAt([{ ...item, origin: 'manual', event_ids: [] }], cur.view, x, y, cur.height)
    return hit ? { ...hit, project: true } : null
  }
  const seekFrame = useCallback((): void => {
    if (frame.current !== null) return
    const tick = (now: number): void => {
      frame.current = null
      const cur = o.current
      if (!pointer.current || cur.disabled) return
      const { x } = local(pointer.current.clientX, pointer.current.clientY)
      if (st.current.phase === 'scrub' || st.current.phase === 'handle') {
        const view = scrubAutoPan(cur.view, x, lastFrame.current === null ? 16 : now - lastFrame.current)
        lastFrame.current = now
        if (view.start !== cur.view.start) cur.onAutoScroll(() => view)
        if (st.current.phase === 'handle') updateHandleRef.current(x, 'preview', view)
        else {
          const t = timeAt(x, view)
          if (t !== lastSeek.current) cur.onSeek(t)
          lastSeek.current = t
        }
        frame.current = requestAnimationFrame(tick)
      } else if (bladeRef.current.enabled && bladeRef.current.hover !== null) {
        cur.onHoverSeek?.(bladeRef.current.hover)
      }
    }
    frame.current = requestAnimationFrame(tick)
  }, [local])

  const onMouseDown = useCallback((e: ReactMouseEvent<HTMLElement>): void => {
    const cur = o.current
    if (cur.disabled || (e.button !== 0 && e.button !== 1)) return
    e.preventDefault()
    const { x, y } = local(e.clientX, e.clientY)
    pointer.current = { clientX: e.clientX, clientY: e.clientY }
    cur.wrapRef.current?.focus()
    if (e.button === 0 && bladeRef.current.enabled) {
      applyBlade({ type: 'click', t: timeAt(x) })
      seekFrame()
      return
    }
    const headX = timeToX(playheadTarget({ playing: cur.playing, time: cur.currentTime, getTime: cur.getPlayTime }), cur.view)
    const handle = projectHandle(x, y) ?? handleAt(cur.clips, cur.view, x, y, cur.height)
    const playhead = !handle && Math.abs(x - headX) <= HANDLE_HIT_PX
    apply({ type: 'down', x, y, button: e.button, shift: e.shiftKey || e.ctrlKey, playhead, handle })
    originalClip.current = handle && !handle.project ? cur.clips.find((c) => c.id === handle.clipId) ?? null : null
    setInteracting(true)
    if (st.current.phase === 'pan') {
      panStart.current = { clientX: e.clientX, start: cur.view.start }
      setCursor('grabbing')
    } else if (st.current.phase === 'handle') setCursor('ew-resize')
    else if (st.current.phase === 'scrub') {
      beginScrub()
      seekFrame()
    }
    setTip(null)
  }, [apply, applyBlade, beginScrub, local, seekFrame])

  // Attach dragging to window so it continues outside the timeline; Esc/blur restores the original state.
  useEffect(() => {
    const cancelGesture = (): void => {
      stopFrame()
      const cur = o.current
      const restore = cancelRestore(st.current, originalClip.current)
      const h = st.current.handle
      if (h?.project) cur.onProjectTrim?.(h.clipId, h.edge, 0, 'cancel')
      if (scrubStart.current) {
        const original = scrubStart.current
        cur.onSeek(original.time)
        cur.onAutoScroll(() => original.view)
        cur.onScrubEnd?.(true)
      }
      scrubStart.current = null
      apply({ type: 'cancel' })
      originalClip.current = null
      panStart.current = null
      setInteracting(false)
      setCursor(bladeRef.current.enabled ? 'crosshair' : 'pointer')
      if (restore) cur.onUpdateClip?.(restore)
    }
    cancelGestureRef.current = cancelGesture
    const onMove = (e: MouseEvent): void => {
      if (st.current.phase === 'idle') return
      if (shouldCancel(st.current.phase, { type: 'move', buttons: e.buttons })) return cancelGesture()
      const { x, y } = local(e.clientX, e.clientY)
      pointer.current = { clientX: e.clientX, clientY: e.clientY }
      apply({ type: 'move', x, y })
      const cur = o.current
      if (st.current.phase === 'pan' && panStart.current) {
        const dt = ((panStart.current.clientX - e.clientX) / Math.max(1, cur.view.width)) * cur.view.span
        const target = panStart.current.start + dt
        cur.setView((v) => pan(v, target - v.start))
      } else if (st.current.phase === 'handle') {
        beginScrub('ew-resize')
        seekFrame()
      } else if (st.current.phase === 'scrub') {
        beginScrub()
        seekFrame()
      }
    }
    const onUp = (e: MouseEvent): void => {
      const s = st.current
      if (s.phase === 'idle' || e.button !== (s.phase === 'pan' ? 1 : 0)) return
      const { x, y } = local(e.clientX, e.clientY)
      const cur = o.current
      stopFrame()
      if (s.phase === 'handle') updateHandleRef.current(x, 'commit')
      const outcome = apply({ type: 'up', x, y })
      panStart.current = null
      originalClip.current = null
      setInteracting(false)
      setCursor(bladeRef.current.enabled ? 'crosshair' : 'pointer')
      if (outcome === 'scrub' || (outcome === 'handle' && scrubStart.current)) {
        if (outcome === 'scrub') cur.onSeek(timeAt(x))
        scrubStart.current = null
        cur.onScrubEnd?.(false)
      } else if (outcome === 'click') {
        const L = cur.layoutRef.current
        const inZone = s.y0 >= ITEM_HIT_Y[0] && s.y0 <= ITEM_HIT_Y[1]
        const hit = L.mode === 'icons' && inZone ? hitItem(L.items, s.x0, ITEM_HIT_PX) : null
        if (hit && hit.events.length === 1) {
          const ev = hit.events[0]
          if (s.shift) cur.onToggleSelect?.(ev.id)
          else if (cur.onSelectEvent) cur.onSelectEvent(ev)
          else cur.onSeek(Math.max(0, ev.t - cur.seekBefore))
        } else if (hit) cur.setView((v) => zoomToCluster(hit, v))
        else cur.onSeek(timeAt(s.x0))
      }
    }
    const leavePreview = (): void => {
      stopFrame()
      applyBlade({ type: 'leave' })
      o.current.onHoverSeek?.(null)
      setTip(null)
    }
    const onBlur = (): void => {
      if (shouldCancel(st.current.phase, { type: 'blur' })) cancelGesture()
      leavePreview()
    }
    const detachEsc = attachGestureEscape(window,
      () => st.current.phase !== 'idle' ? st.current.phase
        : bladeRef.current.enabled && !o.current.disabled ? 'pressed' : 'idle',
      () => {
        if (st.current.phase !== 'idle') return cancelGesture()
        applyBlade({ type: 'escape' })
        if (!bladeRef.current.enabled) {
          leavePreview()
          o.current.onBladeModeChange?.(false)
        }
      })
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('blur', onBlur)
      detachEsc()
      stopFrame()
      if (scrubStart.current) {
        o.current.onSeek(scrubStart.current.time)
        o.current.onScrubEnd?.(true)
      }
      const h = st.current.handle
      if (h?.project) o.current.onProjectTrim?.(h.clipId, h.edge, 0, 'cancel')
      o.current.onHoverSeek?.(null)
    }
  }, [apply, applyBlade, beginScrub, local, seekFrame, stopFrame])

  useEffect(() => {
    if ((opts.bladeMode || opts.disabled) && st.current.phase !== 'idle') cancelGestureRef.current()
    applyBlade({ type: 'enable', enabled: !!opts.bladeMode })
    if (!opts.bladeMode || opts.disabled) {
      stopFrame()
      if (opts.disabled) applyBlade({ type: 'leave' })
      o.current.onHoverSeek?.(null)
      if (!opts.bladeMode) setCursor('pointer')
      setTip(null)
    }
  }, [opts.bladeMode, opts.disabled, applyBlade, stopFrame])

  // Wheel: zoom (onZoom centers on the playhead; Ctrl does the same); Shift+wheel or horizontal trackpad scroll pans when zoomed in.
  useEffect(() => {
    const el = opts.wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      const cur = o.current
      if (cur.disabled || st.current.phase !== 'idle') return
      const horizontal = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)
      if (horizontal) {
        if (cur.view.span >= cur.view.duration) return
        e.preventDefault()
        const delta = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX
        cur.setView((v) => pan(v, (delta / 100) * v.span * 0.15))
        return
      }
      if (e.deltaY === 0) return
      e.preventDefault()
      const factor = e.deltaY < 0 ? 0.7 : 1.4
      if (cur.onZoom) cur.onZoom(factor, xToTime(local(e.clientX, e.clientY).x, cur.view))
      else {
        const anchor = xToTime(local(e.clientX, e.clientY).x, cur.view)
        cur.setView((v) => zoom(v, factor, anchor))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [opts.wrapRef, local])

  const onMouseMove = useCallback((e: ReactMouseEvent<HTMLElement>): void => {
    if (st.current.phase !== 'idle' || o.current.disabled) return
    const { x, y } = local(e.clientX, e.clientY)
    const cur = o.current
    let text: string | null
    if (bladeRef.current.enabled) {
      pointer.current = { clientX: e.clientX, clientY: e.clientY }
      applyBlade({ type: 'move', t: timeAt(x) })
      seekFrame()
      text = formatTime(timeAt(x))
      setCursor('crosshair')
    } else {
      const clip = clipAt(cur.clips, cur.view, x, y)
      setHoverClipId(clip?.id ?? null)
      const handle = projectHandle(x, y) ?? handleAt(cur.clips, cur.view, x, y, cur.height)
      const headX = timeToX(playheadTarget({ playing: cur.playing, time: cur.currentTime, getTime: cur.getPlayTime }), cur.view)
      setCursor(handle ? 'ew-resize' : Math.abs(x - headX) <= HANDLE_HIT_PX ? 'grab' : 'pointer')
      text = tooltipAt(cur.layoutRef.current, x, y)
    }
    const next = text ? { x: Math.min(x + 10, Math.max(0, cur.view.width - 260)), y: Math.max(y - 34, 24), text } : null
    setTip((prev) => tipChanged(prev, next) ? next : prev)
  }, [applyBlade, local, seekFrame])

  const onMouseLeave = useCallback((): void => {
    if (bladeRef.current.enabled) {
      stopFrame()
      applyBlade({ type: 'leave' })
      o.current.onHoverSeek?.(null)
    }
    if (st.current.phase !== 'idle') return
    setHoverClipId(null)
    setTip(null)
  }, [applyBlade, stopFrame])

  return { onMouseDown, onMouseMove, onMouseLeave, interacting, blade, hoverClipId,
    cursor: blade.enabled && st.current.phase === 'idle' ? 'crosshair' : cursor, tip }
}
