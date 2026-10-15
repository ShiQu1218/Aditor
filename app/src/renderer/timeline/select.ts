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

export function hitDensity(items: LayoutItem[], x: number, tolPx = 6): EngineEvent[] {
  const out: EngineEvent[] = []
  for (const it of items) {
    if (Math.abs(it.x - x) <= tolPx) out.push(...it.events)
  }
  return out
}
