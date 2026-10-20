import { mergeOnReanalyze } from '../shared/clips'
import type { CacheDoc, Clip } from '../shared/types'
import fs from 'fs'
import path from 'path'
import { cacheFilePath, loadCacheDoc, saveCacheDoc } from './cache-io'

/** Clip backup file: `<sha1>.clips.json` beside the cache. */
export function clipsBackupPath(cachePath: string): string {
  return cachePath.replace(/\.json$/i, '') + '.clips.json'
}

/** Read the backup; return null if missing, corrupt, or malformed (caller falls back to clips from the cache document). */
export function readClipsBackup(cachePath: string): Clip[] | null {
  try {
    const data = JSON.parse(fs.readFileSync(clipsBackupPath(cachePath), 'utf-8'))
    return data && data.version === 1 && Array.isArray(data.clips) ? (data.clips as Clip[]) : null
  } catch {
    return null
  }
}

/** Atomically write a backup (tmp + fsync + rename); log failures and return false. */
function writeClipsBackup(cachePath: string, clips: Clip[]): boolean {
  const dest = clipsBackupPath(cachePath)
  const tmp = `${dest}.tmp`
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const fd = fs.openSync(tmp, 'w')
    try {
      fs.writeSync(fd, JSON.stringify({ version: 1, clips }), null, 'utf-8')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, dest)
    return true
  } catch (err) {
    console.error('[Reanalysis] failed to write clips backup:', err)
    try {
      fs.unlinkSync(tmp)
    } catch {}
    return false
  }
}

function deleteClipsBackup(cachePath: string): void {
  try {
    fs.unlinkSync(clipsBackupPath(cachePath))
  } catch {}
}

/** Read-only snapshot of the existing cache before analysis (never write it back). */
export interface PriorCache {
  clips: Clip[]
  /** Whether analysis of the old document was complete (partial = resume after interrupted first analysis, not a reanalysis). */
  done: boolean
  /** Used to detect when the engine returns a cache hit directly: identical video and analysis means no reanalysis occurred. */
  fingerprint: string
}

const fingerprintOf = (doc: Partial<CacheDoc>): string => JSON.stringify([doc.video ?? null, doc.analysis ?? null])

/**
 * Called before analysis: read the existing cache and maintain a clip backup.
 * - Cache document `done`: write its clips to the backup (replacing the old backup; during reanalysis the engine overwrites the cache with a document containing only manual clips).
 * - Cache document `partial` (cancelled/interrupted last time): keep the existing backup and continue using its clips.
 * - Prefer the backup over document clips (which may be incomplete); ignore corrupt backups.
 * No cache and no backup → null (first analysis).
 */
export function capturePriorCache(videoPath: string, cacheDir: string, beside = false): PriorCache | null {
  const cachePath = cacheFilePath(videoPath, cacheDir, beside)
  const doc = loadCacheDoc(cachePath) as Partial<CacheDoc> | null
  const hasDoc = !!doc && typeof doc === 'object'
  const docDone = hasDoc && doc!.analysis?.status === 'done'
  const docClips = hasDoc && Array.isArray(doc!.clips) ? doc!.clips! : []

  if (docDone) writeClipsBackup(cachePath, docClips)
  const backup = readClipsBackup(cachePath)
  if (!hasDoc && !backup) return null
  return {
    clips: backup ?? docClips,
    done: docDone || backup !== null,
    fingerprint: hasDoc ? fingerprintOf(doc!) : ''
  }
}

/**
 * Called after analysis **succeeds**. The engine's `merge_clips` keeps only manual clips and overwrites the cache, so during reanalysis
 * main restores clips using `mergeOnReanalyze(oldClips, [])` (keep manual clips; keep added AI clips and mark them stale;
 * discard suggested/skipped clips), and sets `app.suggestionsPending = true` so Studio recomputes suggestions on open (once only).
 *
 * Cases not handled (return false and leave the engine-written cache unchanged): first analysis (no prior cache), old document incomplete,
 * new result incomplete, or engine returns the cache directly (video/analysis unchanged from before analysis = cache hit, not reanalysis).
 * This function is not called on cancellation/failure: leave the backup beside the cache so a resume/rerun can keep using it
 * (the engine has already overwritten the cache with a partial containing only manual clips before cancellation).
 */
export function preserveClipsAfterReanalysis(
  prior: PriorCache | null,
  result: CacheDoc,
  videoPath: string,
  cacheDir: string,
  beside = false
): boolean {
  if (!prior || !prior.done) return false
  if (!result || result.analysis?.status !== 'done') return false
  const cachePath = result.cache_path || cacheFilePath(videoPath, cacheDir, beside)
  if (fingerprintOf(result) === prior.fingerprint) {
    // The engine returned the cache directly: no reanalysis occurred, so the backup just created is no longer needed.
    deleteClipsBackup(cachePath)
    return false
  }
  const doc: CacheDoc = {
    ...result,
    cache_path: cachePath,
    clips: mergeOnReanalyze(prior.clips, []),
    app: { ...result.app, suggestionsPending: true }
  }
  const ok = saveCacheDoc(doc)
  // Delete the backup only after the rewrite succeeds; keep it on failure for the next attempt.
  if (ok) deleteClipsBackup(cachePath)
  return ok
}
