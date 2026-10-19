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
  const ids = new Set(kept.map((c) => c.id))
  const added: Clip[] = []
  for (const n of normalizeClips(newAi)) {
    if (n.origin !== 'ai') continue
    if (kept.some((k) => Math.abs(k.start - n.start) < 1)) continue
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
