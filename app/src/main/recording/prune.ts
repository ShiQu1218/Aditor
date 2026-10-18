import fs from 'fs'
import path from 'path'
import type { LiveMatch, LiveSegment } from '../../shared/recording'
import { MATCH_PRE_PAD_SEC, MATCH_POST_PAD_SEC, validateSessionDir, writeJson } from './finalize'

export const LOBBY_BUFFER_SEC = 15

/** 呼叫端與剪檔共用序列；標記先落盤，避免中斷後誤用整段輸出。 */
export async function pruneSegments(dir: string, segments: readonly LiveSegment[], matches: readonly LiveMatch[], pending: number | null, healthy: () => boolean = () => true,
  onRemoved: (sequences: number[]) => void = () => {}): Promise<number[]> {
  const latest = segments.reduce((t, s) => Math.max(t, s.pts), 0)
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
      if (!Number.isSafeInteger(s.seq) || s.seq <= 0) throw new Error('錄影片段序號無效')
      const file = path.join(dir, `seg_${String(s.seq).padStart(6, '0')}.m4s`)
      try {
        const stat = await fs.promises.lstat(file)
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('錄影片段不是一般檔案')
        if (!healthy()) break
        await fs.promises.unlink(file)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      removed.push(s.seq)
    }
  } finally { onRemoved(removed) }
  return removed
}
