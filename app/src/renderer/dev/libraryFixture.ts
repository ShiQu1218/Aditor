import type { LibraryEntry } from '../../main/library'
import type { QueuePayload } from '../../shared/queueState'

const PREFIXES = ['Apex Legends', 'Apex Legends', 'Apex Legends', 'Ranked', 'Mixtape']
const DAY = 24 * 60 * 60 * 1000

/** Generate count synthetic library entries spanning about 40 days, with mixed states and some favorites and highlight counts (shared within a page load). */
let cached: LibraryEntry[] | null = null
export function libraryFixtureOnce(): LibraryEntry[] {
  cached ??= makeLibraryFixture()
  return cached
}

export function makeLibraryFixture(count = 500, now = Date.now()): LibraryEntry[] {
  const entries: LibraryEntry[] = []
  let analyzingTaken = false
  for (let i = 0; i < count; i++) {
// Several videos per day, with newer entries first.
    const addedAt = now - Math.floor((i / count) * 40) * DAY - (i % 7) * 37 * 60 * 1000
    const roll = i % 11
    const base: LibraryEntry = {
      path: `D:\\fixture\\${PREFIXES[i % PREFIXES.length]}_${new Date(addedAt).toISOString().slice(0, 10)}_${String(i % 24).padStart(2, '0')}-${String(i % 60).padStart(2, '0')}-00-000.mp4`,
      addedAt,
      favorite: i % 9 === 0,
      status: 'done',
      progress: 1,
      durationSec: 300 + ((i * 37) % 9000),
      counts: { knock: (i * 7) % 40, assist: (i * 5) % 25 },
      hl: (i * 3) % 12,
      codec: i % 6 === 0 ? 'av1' : 'h264'
    }
    if (roll === 5) entries.push({ ...base, status: 'pending', progress: 0, counts: undefined, hl: 0, durationSec: undefined })
    else if (roll === 6 && !analyzingTaken) {
// Analyze one video at a time; the remaining six in each roll are marked as "not analyzed yet."
      analyzingTaken = true
      entries.push({ ...base, status: 'analyzing', progress: 0.42, analyzingSince: now - 95_000, counts: undefined, hl: 0 })
    } else if (roll === 6) entries.push({ ...base, status: 'pending', progress: 0, counts: undefined, hl: 0, durationSec: undefined })
    else if (roll === 7) entries.push({ ...base, status: 'error', progress: 0, error: 'ffprobe 回報檔案損壞（moov atom not found）', counts: undefined, hl: 0 })
    else entries.push(base)
  }
  return entries
}

/** Synthetic queue state: the first video is analyzing, the next four are queued, and other pending entries are not yet analyzed (not queued). */
export function makeQueueFixture(): QueuePayload {
  const entries = libraryFixtureOnce()
  const analyzing = entries.find((e) => e.status === 'analyzing')
  const queued = entries
    .filter((e) => e.status === 'pending')
    .slice(0, 4)
    .map((e) => e.path)
  return {
    queue: { analyzing: analyzing?.path ?? null, queued },
    current: analyzing
      ? { path: analyzing.path, progress: analyzing.progress, analyzingSince: analyzing.analyzingSince ?? null }
      : null
  }
}
