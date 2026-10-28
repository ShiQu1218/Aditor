import { mergeSavedEvents } from '../shared/events'
import { mergeOnReanalyze } from '../shared/clips'
import type { CacheDoc, Clip, EngineEvent } from '../shared/types'
import fs from 'fs'
import path from 'path'
import { cacheBelongsToVideo, cacheFilePath, legacyCacheFilePath, loadCacheDoc, resolveCacheFile, saveCacheDoc } from './cache-io'
import { tr } from '../shared/locale'

/** Reanalysis backup: v2 carries event/clip state; v3 carries a document edited during analysis. */
export function clipsBackupPath(cachePath: string): string {
  return cachePath.replace(/\.json$/i, '') + '.clips.json'
}

interface ReanalysisBackup {
  events: EngineEvent[]
  clips: Clip[]
  document?: CacheDoc
}

function readReanalysisBackup(cachePath: string): ReanalysisBackup | null {
  try {
    const data = JSON.parse(fs.readFileSync(clipsBackupPath(cachePath), 'utf-8'))
    if (data?.version === 3 && typeof data.document?.video?.path === 'string' && Array.isArray(data.document.events) && Array.isArray(data.document.clips)) {
      return { events: data.document.events, clips: data.document.clips, document: data.document }
    }
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
function writeReanalysisBackup(cachePath: string, events: EngineEvent[], clips: Clip[], document?: CacheDoc): boolean {
  const dest = clipsBackupPath(cachePath)
  const tmp = `${dest}.tmp`
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const fd = fs.openSync(tmp, 'w')
    try {
      fs.writeSync(fd, JSON.stringify(document ? { version: 3, document } : { version: 2, events, clips }), null, 'utf-8')
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

/** Keep edits out of the engine-owned file until analysis has committed its result. */
function savePendingCacheDoc(doc: CacheDoc): boolean {
  return writeReanalysisBackup(doc.cache_path, doc.events, doc.clips, doc)
}

function editedBackup(videoPath: string, cacheDir: string, beside: boolean): { path: string; backup: ReanalysisBackup } | null {
  const candidates = [cacheFilePath(videoPath, cacheDir, beside), cacheFilePath(videoPath, cacheDir, !beside), legacyCacheFilePath(videoPath, cacheDir, true)]
  let newest: { path: string; backup: ReanalysisBackup; time: number } | null = null
  for (const candidate of new Set(candidates)) {
    const backup = readReanalysisBackup(candidate)
    if (!backup?.document || path.resolve(backup.document.video.path).toLowerCase() !== path.resolve(videoPath).toLowerCase()) continue
    const time = fs.statSync(clipsBackupPath(candidate)).mtimeMs
    if (!newest || time > newest.time) newest = { path: candidate, backup, time }
  }
  return newest
}

/** Reopening a source must include edits saved while its engine cache was being replaced. */
export function loadCacheWithEdits(videoPath: string, cacheDir: string, beside = false): unknown | null {
  const source = resolveCacheFile(videoPath, cacheDir, beside)
  const doc = loadCacheDoc(source) as CacheDoc | null
  const backup = editedBackup(videoPath, cacheDir, beside)?.backup ?? readReanalysisBackup(source)
  if (!backup) return doc
  if (!doc) return backup.document ?? null
  return { ...doc, events: mergeSavedEvents(backup.events, doc.events ?? []), clips: backup.clips, app: backup.document?.app ?? doc.app }
}

/** Existing interrupted-analysis backups must also receive later edits. */
export function saveCacheEdits(doc: CacheDoc, cacheDir: string, beside: boolean, activePath?: string): boolean {
  const pending = editedBackup(doc.video.path, cacheDir, beside)
  const target = activePath ?? pending?.path ?? doc.cache_path
  if (activePath || pending || doc.analysis?.status === 'partial' || fs.existsSync(clipsBackupPath(target))) {
    return savePendingCacheDoc({ ...doc, cache_path: target })
  }
  return saveCacheDoc(doc)
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
  /** Source backup copied to backupPath; removed once its clips are merged, or switching back would replay it. */
  sourceBackupPath?: string
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
  const editing = editedBackup(videoPath, cacheDir, beside)?.backup
  const legacyBackup = readLegacyBackup(videoPath, cacheDir, sourcePath)
  let doc = loadCacheDoc(sourcePath) as (Partial<CacheDoc> & { base_events?: EngineEvent[] }) | null
  if (doc && sourcePath !== cachePath) {
    const migrated = { ...doc, cache_path: cachePath }
    if (saveCacheDoc(migrated as { cache_path: string })) doc = migrated
  }
  const hasDoc = !!doc && typeof doc === 'object'
  const docDone = hasDoc && doc!.analysis?.status === 'done'
  const docClips = hasDoc && Array.isArray(doc!.clips) ? doc!.clips! : []

  // A backup still beside a done cache was never merged back (restore write failed or the app quit first); keep it.
  // A migrated source carries its own unmerged backup; the newest copy (resolveCacheFile) decides which one applies.
  const unconsumed = docDone && !editing ? readReanalysisBackup(cachePath) ?? sourceBackup : null
  if (docDone && !editing && !unconsumed && !writeReanalysisBackup(cachePath, (doc!.events ?? []) as EngineEvent[], docClips as Clip[])) {
    throw new Error(tr('無法備份編輯內容，已停止重新分析'))
  }
  const targetBackup = readReanalysisBackup(cachePath)
  const backup = editing ?? targetBackup ?? sourceBackup ?? legacyBackup
  if (backup && (!targetBackup || editing) && !writeReanalysisBackup(cachePath, backup.events, backup.clips, backup.document)) {
    throw new Error(tr('無法備份編輯內容，已停止重新分析'))
  }
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
    backupPath: cachePath,
    ...(backup && backup === sourceBackup && sourcePath !== cachePath ? { sourceBackupPath: sourcePath } : {})
  }
}

/**
 * Called after analysis **succeeds**. The engine's `merge_clips` keeps only manual clips and overwrites the cache, so during reanalysis
 * main restores clips using `mergeOnReanalyze(oldClips, [])` (keep manual clips; keep added AI clips and mark them stale;
 * discard suggested/skipped clips), and sets `app.suggestionsPending = true` so Studio recomputes suggestions on open (once only).
 *
 * Without pending user edits, leave first/incomplete analyses and non-forced cache hits unchanged.
 * Pending edits are restored even on a first analysis or cache hit; incomplete results keep their backup.
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
  if (!result || result.analysis?.status !== 'done') return false
  const editing = editedBackup(videoPath, cacheDir, beside)
  if (!editing && (!prior || !prior.done)) return false
  const saved = editing?.backup ?? prior!
  const cachePath = result.cache_path || prior?.backupPath || cacheFilePath(videoPath, cacheDir, beside)
  const cacheHit = !force && prior?.fingerprint === fingerprintOf(result)
  if (cacheHit && !editing) {
    // The engine returned the cache directly: no reanalysis occurred, so the backup just created is no longer needed.
    deleteClipsBackup(cachePath)
    return false
  }
  const doc: CacheDoc = {
    ...result,
    cache_path: cachePath,
    events: mergeSavedEvents(saved.events, result.events ?? []),
    clips: cacheHit ? saved.clips : mergeOnReanalyze(saved.clips, []),
    app: cacheHit ? { ...result.app, ...editing?.backup.document?.app } : { ...result.app, suggestionsPending: true }
  }
  const ok = saveCacheDoc(doc)
  // Delete the backup only after the rewrite succeeds; keep it on failure for the next attempt.
  if (ok) {
    for (const backupPath of new Set([cachePath, prior?.backupPath, prior?.sourceBackupPath, editing?.path])) if (backupPath) deleteClipsBackup(backupPath)
    for (const candidate of [cacheFilePath(videoPath, cacheDir, !beside), legacyCacheFilePath(videoPath, cacheDir, true)]) {
      const edited = readReanalysisBackup(candidate)?.document
      if (edited && path.resolve(edited.video.path).toLowerCase() === path.resolve(videoPath).toLowerCase()) deleteClipsBackup(candidate)
    }
  }
  return ok
}
