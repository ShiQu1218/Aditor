import { EngineEvent } from '../../shared/types'
import type { LayoutItem } from './layout'

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

/** Items are sorted by ascending x (output of layoutTimeline): binary-search the start and scan only items within ±tol. */
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
