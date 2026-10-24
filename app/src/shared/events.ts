import type { EngineEvent } from './types'

function eventFamily(type: string): string {
  if (type === 'assist_knock' || type === 'assist_elim') return 'assist'
  if (type === 'multikill' || type === 'ace') return 'highlight'
  return type
}

/** Carry saved manual events and user state onto fresh detections. */
export function mergeSavedEvents(oldEvents: EngineEvent[], newEvents: EngineEvent[]): EngineEvent[] {
  const manual = [...new Map(oldEvents.filter((event) => event.source === 'manual').map((event) => [event.id, event])).values()]
  const manualIds = new Set(manual.map((event) => event.id))
  const fresh = newEvents.filter((event) => event.source !== 'manual' || !manualIds.has(event.id)).map((event) => ({ ...event }))
  const oldState = oldEvents.filter((event) => event.source !== 'manual' &&
    (event.deleted === true || event.counted_override !== null && event.counted_override !== undefined)).sort((a, b) => a.t - b.t)
  const usedOld = new Set<number>()
  const usedFresh = new Set<number>()
  const carry = (fresh: EngineEvent, old: EngineEvent): void => {
    fresh.deleted = old.deleted
    fresh.counted_override = old.counted_override
  }
  for (let oldIndex = 0; oldIndex < oldState.length; oldIndex++) {
    const match = fresh.findIndex((event, index) => event.source !== 'manual' && !usedFresh.has(index) && event.id === oldState[oldIndex].id)
    if (match >= 0) { usedOld.add(oldIndex); usedFresh.add(match); carry(fresh[match], oldState[oldIndex]) }
  }
  for (let oldIndex = 0; oldIndex < oldState.length; oldIndex++) {
    if (usedOld.has(oldIndex)) continue
    const old = oldState[oldIndex]
    let nearest = -1
    let minDist = Infinity
    for (let freshIndex = 0; freshIndex < fresh.length; freshIndex++) {
      if (usedFresh.has(freshIndex) || fresh[freshIndex].source === 'manual') continue
      const dist = Math.abs(old.t - fresh[freshIndex].t)
      if (eventFamily(old.type) === eventFamily(fresh[freshIndex].type) && dist <= 1 && dist < minDist) {
        nearest = freshIndex
        minDist = dist
      }
    }
    if (nearest >= 0) { usedOld.add(oldIndex); usedFresh.add(nearest); carry(fresh[nearest], old) }
  }
  return [...manual, ...fresh].sort((a, b) => a.t - b.t)
}

