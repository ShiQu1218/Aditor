import { isCounted, type EngineEvent, type EventType } from '../../shared/types'
import type { GameId } from '../../shared/games'

/**
 * Fixed order for event-type chips (spec §5.2). The engine outputs only knock and assist (assist knock/assist elimination);
 * elim/squad_wipe no longer have filter chips. Existing events of these types in old projects/caches remain visible (the default filter set includes them), preserving type compatibility.
 */
export const CHIP_TYPES: EventType[] = ['knock', 'assist_knock', 'assist_elim']
/** Valorant analysis emits kills and deaths. */
export const VALORANT_CHIP_TYPES: EventType[] = ['kill', 'death']

export function chipTypesFor(game: GameId | undefined): EventType[] {
  return game === 'valorant' ? VALORANT_CHIP_TYPES : CHIP_TYPES
}

/** Count of undeleted events of each type (shown on chips). */
export function chipCounts(events: EngineEvent[]): Record<EventType, number> {
  const out = { knock: 0, assist_knock: 0, assist_elim: 0, elim: 0, squad_wipe: 0, kill: 0, death: 0, multikill: 0, ace: 0 } as Record<EventType, number>
  for (const e of events) {
    if (e.deleted) continue
    if (e.type in out) out[e.type as EventType] += 1
  }
  return out
}

/** Toggle one type (return a new set without mutating the original). */
export function toggleFilter(filter: Set<EventType>, t: EventType): Set<EventType> {
  const next = new Set(filter)
  if (next.has(t)) next.delete(t)
  else next.add(t)
  return next
}

/** "Included in the last 90 seconds": count undeleted, included events in [t-90, t] (informational, spec §3.2.1). */
export function nearCount(events: EngineEvent[], t: number, windowSec = 90): number {
  const from = t - windowSec
  let n = 0
  for (const e of events) {
    if (e.t < from || e.t > t) continue
    if (e.deleted) continue
    if (isCounted(e)) n += 1
  }
  return n
}
