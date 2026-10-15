import { EngineEvent, EventType, isCounted } from '../../shared/types'
import { View, timeToX, xToTime } from './model'

export const MIN_PX_PER_EVENT = 8
export const CLUSTER_PX = 22
const MIN_ZOOM_SPAN = 20
const EDGE_MARGIN_PX = 14
/** 群集 x 方向最大延伸（避免連鎖間距 <22px 的事件串成一顆超長膠囊） */
export const CLUSTER_MAX_PX = 6 * CLUSTER_PX

export interface LayoutItem {
  x: number
  events: EngineEvent[]
  /** 群集內是否有任一事件算入（供畫布將未算入者淡化） */
  counted: boolean
}

export interface TimelineLayout {
  mode: 'density' | 'icons'
  items: LayoutItem[]
  visibleCount: number
}

function isSorted(events: EngineEvent[]): boolean {
  for (let i = 1; i < events.length; i++) {
    if (events[i].t < events[i - 1].t) return false
  }
  return true
}

/** 第一個 t >= target 的索引 */
function lowerBound(events: EngineEvent[], target: number): number {
  let lo = 0
  let hi = events.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (events[mid].t < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function layoutTimeline(
  events: EngineEvent[],
  view: View,
  filter: Set<EventType>
): TimelineLayout {
  // 已排序（常態）時不複製、不重排
  const src = isSorted(events) ? events : [...events].sort((a, b) => a.t - b.t)
  const t0 = xToTime(-EDGE_MARGIN_PX, view)
  const t1 = xToTime(view.width + EDGE_MARGIN_PX, view)

  const visible: EngineEvent[] = []
  for (let i = lowerBound(src, t0); i < src.length; i++) {
    const e = src[i]
    if (e.t > t1) break
    if (e.deleted || !filter.has(e.type as EventType)) continue
    visible.push(e)
  }
  const visibleCount = visible.length

  if (visibleCount > 0 && view.width / visibleCount < MIN_PX_PER_EVENT) {
    return {
      mode: 'density',
      visibleCount,
      items: visible.map((e) => ({ x: timeToX(e.t, view), events: [e], counted: isCounted(e) }))
    }
  }

  const items: LayoutItem[] = []
  let cur: EngineEvent[] = []
  let sumX = 0
  let firstX = 0
  let lastX = 0
  const flush = (): void => {
    if (cur.length === 0) return
    items.push({ x: sumX / cur.length, events: cur, counted: cur.some(isCounted) })
  }
  for (const e of visible) {
    const x = timeToX(e.t, view)
    if (cur.length > 0 && x - lastX < CLUSTER_PX && x - firstX <= CLUSTER_MAX_PX) {
      cur.push(e)
      sumX += x
    } else {
      flush()
      cur = [e]
      sumX = x
      firstX = x
    }
    lastX = x
  }
  flush()
  return { mode: 'icons', items, visibleCount }
}

/**
 * 放大到群集：永不縮小。span = clamp(max(20, 群集跨度×1.5), 20, 目前 span×0.6)；
 * 目前 span 已 ≤ 20 s 或群集為空時原樣回傳。
 */
export function zoomToCluster(item: { events: EngineEvent[] }, view: View): View {
  if (item.events.length === 0 || view.span <= MIN_ZOOM_SPAN) return view
  let lo = Infinity
  let hi = -Infinity
  for (const e of item.events) {
    if (e.t < lo) lo = e.t
    if (e.t > hi) hi = e.t
  }
  const span = Math.max(MIN_ZOOM_SPAN, Math.min((hi - lo) * 1.5, view.span * 0.6))
  const center = (lo + hi) / 2
  const start = Math.max(0, Math.min(Math.max(0, view.duration - span), center - span / 2))
  return { ...view, start, span }
}
