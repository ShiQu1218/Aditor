import { mergeSavedEvents } from '../shared/events'
import { mergeOnReanalyze } from '../shared/clips'
import type { CacheDoc, Clip, EngineEvent } from '../shared/types'
import fs from 'fs'
import path from 'path'
import { cacheBelongsToVideo, cacheFilePath, legacyCacheFilePath, loadCacheDoc, resolveCacheFile, saveCacheDoc } from './cache-io'

/** Reanalysis backup file: `<cache>.clips.json`; v2 also carries auto/manual event state. */
export function clipsBackupPath(cachePath: string): string {
  return cachePath.replace(/\.json$/i, '') + '.clips.json'
}

interface ReanalysisBackup {
  events: EngineEvent[]
  clips: Clip[]
}

function readReanalysisBackup(cachePath: string): ReanalysisBackup | null {
  try {
    const data = JSON.parse(fs.readFileSync(clipsBackupPath(cachePath), 'utf-8'))
    if (!data || ![1, 2].includes(data.version) || !Array.isArray(data.clips)) return null
    return { events: data.version === 2 && Array.isArray(data.events) ? data.events as EngineEvent[] : [], clips: data.clips as Clip[] }
  } catch {
    return null
  }
}

/** Read the backup clips; return null if missing, corrupt, or malformed. */
export function readClipsBackup(cachePath: string): Clip[] | null {
  return readReanalysisBackup(cachePath)?.clips ?? null
}

/** A cancelled new-format run can leave the old sidecar beside its legacy source. */
function readLegacyBackup(videoPath: string, cacheDir: string, currentPath: string): ReanalysisBackup | null {
  const legacyPath = legacyCacheFilePath(videoPath, cacheDir, true)
  if (legacyPath === currentPath) return null
  if (!cacheBelongsToVideo(legacyPath, videoPath)) return null
  return readReanalysisBackup(legacyPath)
}

/** Atomically write a backup (tmp + fsync + rename); log failures and return false. */
function writeReanalysisBackup(cachePath: string, events: EngineEvent[], clips: Clip[]): boolean {
  const dest = clipsBackupPath(cachePath)
  const tmp = `${dest}.tmp`
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const fd = fs.openSync(tmp, 'w')
    try {
      fs.writeSync(fd, JSON.stringify({ version: 2, events, clips }), null, 'utf-8')
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

/** Snapshot the existing cache before analysis, migrating a fallback document to the active write path. */
export interface PriorCache {
  events: EngineEvent[]
  clips: Clip[]
  /** Whether analysis of the old document was complete (partial = resume after interrupted first analysis, not a reanalysis). */
  done: boolean
  /** Used to detect when the engine returns a cache hit directly: identical video and analysis means no reanalysis occurred. */
  fingerprint: string
  /** Preferred cache path whose backup must survive cancellation/failure. */
  backupPath: string
}

const fingerprintOf = (doc: Partial<CacheDoc>): string => JSON.stringify([doc.video ?? null, doc.analysis ?? null])

/**
 * Called before analysis: read the existing cache and maintain a full user-state backup.
 * - Cache document `done`: write its events and clips to the backup (replacing the old backup; during reanalysis the engine overwrites the cache with a partial document).
 * - Cache document `partial` (cancelled/interrupted last time): keep the existing backup and continue using its events and clips.
 * - Prefer the backup over document state (which may be incomplete); ignore corrupt backups.
 * No cache and no backup → null (first analysis).
 */
export function capturePriorCache(videoPath: string, cacheDir: string, beside = false): PriorCache | null {
  const cachePath = cacheFilePath(videoPath, cacheDir, beside)
  const sourcePath = resolveCacheFile(videoPath, cacheDir, beside)
  const sourceBackup = readReanalysisBackup(sourcePath)
  const legacyBackup = readLegacyBackup(videoPath, cacheDir, sourcePath)
  let doc = loadCacheDoc(sourcePath) as (Partial<CacheDoc> & { base_events?: EngineEvent[] }) | null
  if (doc && sourcePath !== cachePath) {
    const migrated = { ...doc, cache_path: cachePath }
    if (saveCacheDoc(migrated as { cache_path: string })) doc = migrated
  }
  const hasDoc = !!doc && typeof doc === 'object'
  const docDone = hasDoc && doc!.analysis?.status === 'done'
  const docClips = hasDoc && Array.isArray(doc!.clips) ? doc!.clips! : []

  if (docDone) writeReanalysisBackup(cachePath, (doc!.events ?? []) as EngineEvent[], docClips as Clip[])
  const targetBackup = readReanalysisBackup(cachePath)
  const backup = targetBackup ?? sourceBackup ?? legacyBackup
  if (backup && !targetBackup) writeReanalysisBackup(cachePath, backup.events, backup.clips)
  if (hasDoc && !docDone && backup?.events.length && !Array.isArray(doc!.base_events)) {
    const withBase = { ...doc, cache_path: cachePath, base_events: backup.events }
    if (saveCacheDoc(withBase as { cache_path: string })) doc = withBase
  }
  if (!hasDoc && !backup) return null
  return {
    events: backup?.events ?? (Array.isArray(doc?.events) ? doc.events as EngineEvent[] : []),
    clips: backup?.clips ?? docClips as Clip[],
    done: docDone || backup !== null,
    fingerprint: hasDoc ? fingerprintOf(doc!) : '',
    backupPath: cachePath
  }
}

/**
 * Called after analysis **succeeds**. The engine's `merge_clips` keeps only manual clips and overwrites the cache, so during reanalysis
 * main restores clips using `mergeOnReanalyze(oldClips, [])` (keep manual clips; keep added AI clips and mark them stale;
 * discard suggested/skipped clips), and sets `app.suggestionsPending = true` so Studio recomputes suggestions on open (once only).
 *
 * Cases not handled (return false and leave the engine-written cache unchanged): first analysis (no prior cache), old document incomplete,
 * new result incomplete, or a non-forced run returns unchanged video/analysis metadata (cache hit).
 * This function is not called on cancellation/failure: leave the backup beside the cache so a resume/rerun can keep using it
 * (the engine has already overwritten the cache with a partial containing only manual clips before cancellation).
 */
export function preserveClipsAfterReanalysis(
  prior: PriorCache | null,
  result: CacheDoc,
  videoPath: string,
  cacheDir: string,
  beside = false,
  force = false
): boolean {
  if (!prior || !prior.done) return false
  if (!result || result.analysis?.status !== 'done') return false
  const cachePath = result.cache_path || prior.backupPath || cacheFilePath(videoPath, cacheDir, beside)
  if (!force && fingerprintOf(result) === prior.fingerprint) {
    // The engine returned the cache directly: no reanalysis occurred, so the backup just created is no longer needed.
    deleteClipsBackup(cachePath)
    return false
  }
  const doc: CacheDoc = {
    ...result,
    cache_path: cachePath,
    events: mergeSavedEvents(prior.events, result.events ?? []),
    clips: mergeOnReanalyze(prior.clips, []),
    app: { ...result.app, suggestionsPending: true }
  }
  const ok = saveCacheDoc(doc)
  // Delete the backup only after the rewrite succeeds; keep it on failure for the next attempt.
  if (ok) deleteClipsBackup(prior.backupPath)
  return ok
}
