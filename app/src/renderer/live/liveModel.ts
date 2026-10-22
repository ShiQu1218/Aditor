// Pure functions for watching an active recording: apply main-process updates, find new events, and convert timeline coordinates. No React/DOM dependency.
import type { LiveEvent, LiveMatch, LiveState, LiveUpdate } from '../../shared/recording'
import { fillTemplate } from '../../shared/template'
import { isCounted } from '../../shared/types'

/** Apply a `recording:live` update (ignore updates from other recording jobs); return a new object. */
export function applyLiveUpdate(state: LiveState, update: LiveUpdate): LiveState {
  if (update.sessionId !== state.sessionId) return state
  let next = state
  if (update.segments) next = { ...next, segments: update.segments }
  if (update.segment && !state.segments.some((s) => s.seq === update.segment!.seq)) {
    next = { ...next, segments: [...next.segments, update.segment] }
  }
  if (update.events) next = { ...next, events: update.events }
  if (update.spectating) next = { ...next, spectating: update.spectating }
  if (update.match) {
    const { index, start, end } = update.match
    const matches: LiveMatch[] = next.matches.slice(0, index - 1)
  // Fill in any missed earlier matches (should not happen; keeps indexes consistent).
    while (matches.length < index - 1) matches.push({ start, end: start })
    matches.push({ start, end })
    next = { ...next, matches }
  }
  return next
}

/** Newly appeared included events (for aria-live announcements). */
export function newCountedEvents(prev: LiveEvent[], next: LiveEvent[]): LiveEvent[] {
  const seen = new Set(prev.map((e) => e.id))
  return next.filter((e) => !seen.has(e.id) && isCounted(e))
}

export function liveEnd(state: LiveState): number {
  return state.segments.reduce((end, s) => Math.max(end, s.pts + s.dur), 0)
}

/** Convert time to a timeline percentage (0–100). */
export function pct(t: number, end: number): number {
  if (!(end > 0)) return 0
  return Math.min(100, Math.max(0, (t / end) * 100))
}

/** Substitute `{key}` placeholders in a string template. */
export function fill(template: string, vars: Record<string, string | number>): string {
  return fillTemplate(template, vars)
}

/** Clicking an event in the list seeks to 3 seconds before it. */
export const EVENT_LEAD_SEC = 3
export const SEEK_STEP_SEC = 5
