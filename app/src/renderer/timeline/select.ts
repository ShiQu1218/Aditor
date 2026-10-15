import { EngineEvent, EventType } from '../../shared/types'
import type { LayoutItem } from './layout'

export function boxSelect(
  events: EngineEvent[],
  t1: number,
  t2: number,
  filter: Set<EventType>
): string[] {
  const lo = Math.min(t1, t2)
  const hi = Math.max(t1, t2)
  const ids: string[] = []
  for (const e of events) {
    if (e.deleted || e.t < lo || e.t > hi || !filter.has(e.type as EventType)) continue
    ids.push(e.id)
  }
  return ids
}

export function hitItem<T extends { x: number }>(items: T[], x: number, tolPx = 13): T | null {
  let best: T | null = null
  let bestD = Infinity
  for (const it of items) {
    const d = Math.abs(it.x - x)
    if (d <= tolPx && d < bestD) {
      best = it
      bestD = d
    }
  }
  return best
}

/** items 依 x 遞增排序（layoutTimeline 的輸出）：以二分搜尋找起點，只掃描 ±tol 內的項目 */
export function hitDensity(items: LayoutItem[], x: number, tolPx = 6): EngineEvent[] {
  let lo = 0
  let hi = items.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (items[mid].x < x - tolPx) lo = mid + 1
    else hi = mid
  }
  const out: EngineEvent[] = []
  for (let i = lo; i < items.length && items[i].x <= x + tolPx; i++) out.push(...items[i].events)
  return out
}
