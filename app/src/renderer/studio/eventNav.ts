/**
 * Reference time for previous/next event (Ctrl+←/→).
 * Seeking to an event places the playhead N seconds before it (lead-in). If the next search still uses the playhead time,
 * "next event" finds the same event again and gets stuck (it is still ahead of the playhead), while "previous" skips events within the lead-in interval.
 * Therefore, record the event just reached by navigation as an anchor: while the playhead remains at its lead-in position, use the event's own time as the reference.
 */
export interface NavAnchor {
  /** Event time. */
  eventT: number
  /** Actual seek time during navigation. */
  seekT: number
}

export function navReference(current: number, anchor: NavAnchor | null, tolerance = 0.25): number {
  return anchor && Math.abs(current - anchor.seekT) <= tolerance ? anchor.eventT : current
}
