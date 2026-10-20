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
  const obsolete = segments.filter(s => s.pts + s.dur <= latest - LOBBY_BUFFER_SEC &&
    !(pending !== null && s.pts + s.dur > pending - MATCH_PRE_PAD_SEC) &&
    !matches.some(m => s.pts + s.dur > m.start - MATCH_PRE_PAD_SEC &&
      (m.end === null || s.pts < m.end + MATCH_POST_PAD_SEC)))
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
