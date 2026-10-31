import fs from 'fs'
import path from 'path'
import type { LiveMatch, LiveSegment } from '../../shared/recording'
import { MATCH_PRE_PAD_SEC, MATCH_POST_PAD_SEC, validateSessionDir, writeJson } from './finalize'
import { tr } from '../../shared/locale'

export const LOBBY_BUFFER_SEC = 15

/** The caller and clipper share a serial queue; persist the marker first to avoid using the full output after interruption. */
/** `analyzedT` is the recording time processed by the live engine. Unseen segments may contain a countdown if the engine is behind, so keep them. */
export async function pruneSegments(dir: string, segments: readonly LiveSegment[], matches: readonly LiveMatch[], pending: number | null,
  analyzedT = Infinity, healthy: () => boolean = () => true, onRemoved: (sequences: number[]) => void = () => {}): Promise<number[]> {
  const latest = Math.min(segments.reduce((t, s) => Math.max(t, s.pts), 0), analyzedT)
  const obsolete = obsoleteSegments(segments, matches, pending, latest)
  if (!obsolete.length) return []
  dir = await validateSessionDir(dir)
  await writeJson(path.join(dir, 'pruned.json'), { version: 1 })
  const removed: number[] = []
  try {
    for (const s of obsolete) {
      if (!healthy()) break
      if (!Number.isSafeInteger(s.seq) || s.seq <= 0) throw new Error(tr('錄影片段序號無效'))
      const file = path.join(dir, `seg_${String(s.seq).padStart(6, '0')}.m4s`)
      try {
        const stat = await fs.promises.lstat(file)
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(tr('錄影片段不是一般檔案'))
        if (!healthy()) break
        await fs.promises.unlink(file)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      removed.push(s.seq)
    }
  } finally { onRemoved(removed) }
  return removed
}

/** Pure selection keeps deletion and its health/path checks independent of the interval index. */
export function obsoleteSegments(segments: readonly LiveSegment[], matches: readonly LiveMatch[], pending: number | null, latest: number): LiveSegment[] {
  const ranges = matches.map(m => ({ start: m.start - MATCH_PRE_PAD_SEC, end: m.end === null ? Infinity : m.end + MATCH_POST_PAD_SEC }))
    .filter(m => !Number.isNaN(m.start) && !Number.isNaN(m.end)).sort((a, b) => a.start - b.start)
  let maxEnd = -Infinity
  const ends = ranges.map(m => (maxEnd = Math.max(maxEnd, m.end)))
  return segments.filter(s => {
    if (!(s.pts + s.dur <= latest - LOBBY_BUFFER_SEC) ||
        (pending !== null && s.pts + s.dur > pending - MATCH_PRE_PAD_SEC)) return false
    let lo = 0, hi = ranges.length
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2)
      if (ranges[mid].start < s.pts + s.dur) lo = mid + 1
      else hi = mid
    }
    return !(lo > 0 && ends[lo - 1] > s.pts)
  })
}
