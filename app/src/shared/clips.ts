import type { Clip } from './types'

/** Legacy compatibility: treat missing status as accepted, fill missing event_ids with [], and remove duplicate IDs (keep the first). */
export function normalizeClips(clips: Clip[] | undefined): Clip[] {
  const seen = new Set<string>()
  const out: Clip[] = []
  for (const c of clips ?? []) {
    if (seen.has(c.id)) continue
    seen.add(c.id)
    out.push({ ...c, status: c.status ?? 'accepted', event_ids: c.event_ids ?? [] })
  }
  return out
}

/** Index only retained starts; newly generated suggestions must not suppress one another. */
export function retainedStartLookup(clips: Clip[]): (start: number) => boolean {
  const starts = clips.map((c) => c.start).filter(Number.isFinite).sort((a, b) => a - b)
  return (start) => {
    if (!Number.isFinite(start)) return false
    let lo = 0, hi = starts.length
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2)
      if (starts[mid] < start) lo = mid + 1
      else hi = mid
    }
    return (lo < starts.length && Math.abs(starts[lo] - start) < 1) ||
      (lo > 0 && Math.abs(starts[lo - 1] - start) < 1)
  }
}

/**
 * Reanalysis merge rules (extension to spec §4.2):
 * keep all manual clips; keep accepted AI clips and mark them stale; discard old suggested/skipped AI clips;
 * skip new AI clips whose start is within < 1s of a retained clip; add the rest as suggested; sort by start.
 */
export function mergeOnReanalyze(oldClips: Clip[], newAi: Clip[]): Clip[] {
  const kept: Clip[] = []
  for (const c of normalizeClips(oldClips)) {
    if (c.origin === 'manual') kept.push(c)
    else if (c.status === 'accepted') kept.push({ ...c, stale: true })
  }
  const nearRetained = retainedStartLookup(kept)
  const ids = new Set(kept.map((c) => c.id))
  const added: Clip[] = []
  for (const n of normalizeClips(newAi)) {
    if (n.origin !== 'ai') continue
    if (nearRetained(n.start)) continue
    // Generate a new ID if it collides with a retained clip, so the suggestion is not lost.
    let id = n.id
    while (ids.has(id)) id = `${id}_n`
    ids.add(id)
    const { stale: _stale, ...rest } = n
    added.push({ ...rest, id, status: 'suggested' })
  }
  return [...kept, ...added].sort((a, b) => a.start - b.start)
}

export function suggestionCount(clips: Clip[]): number {
  return clips.filter((c) => c.status === 'suggested').length
}
