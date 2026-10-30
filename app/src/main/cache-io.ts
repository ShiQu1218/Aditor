import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

/** Read cache JSON; return null when missing or corrupt. Return contents as-is (including Clip.status); renderer's normalizeClips handles migration. */
export function loadCacheDoc(cachePath: string): unknown | null {
  try {
    if (fs.existsSync(cachePath)) {
      return JSON.parse(fs.readFileSync(cachePath, 'utf-8'))
    }
  } catch (err) {
    console.error('Failed to load cache:', err)
  }
  return null
}

/** Write atomically (tmp + rename). */
export function saveCacheDoc(doc: { cache_path: string }): boolean {
  try {
    if (doc && doc.cache_path) {
      const dest = doc.cache_path
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      const tmp = `${dest}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf-8')
      fs.renameSync(tmp, dest)
      return true
    }
  } catch (err) {
    console.error('Failed to save cache:', err)
  }
  return false
}

/**
 * Uses the same rule as the engine's `cache_path(video, cache_dir, beside)` in cache.py:
 * beside ⇒ `<video directory>/<filename>.aditor.json`; otherwise, use the lowercase, slash-normalized abspath's SHA-1 in the cache directory.
 */
export function cacheFilePath(videoPath: string, cacheDir: string, beside = false): string {
  if (beside) {
    const v = path.parse(videoPath)
    return path.join(v.dir, `${v.base}.aditor.json`)
  }
  const key = crypto.createHash('sha1').update(path.resolve(videoPath).toLowerCase().replace(/\\/g, '/')).digest('hex')
  return path.join(cacheDir, `${key}.json`)
}

/** The pre-full-filename beside-video name, retained only for validated reads. */
export function legacyCacheFilePath(videoPath: string, cacheDir: string, beside = false): string {
  if (!beside) return cacheFilePath(videoPath, cacheDir)
  const v = path.parse(videoPath)
  return path.join(v.dir, `${v.name}.aditor.json`)
}

function normalizedVideoPath(videoPath: string): string {
  return path.resolve(videoPath).toLowerCase().replace(/\\/g, '/')
}

function readCacheObject(cachePath: string): { video?: { path?: unknown } } | null {
  try {
    const doc = JSON.parse(fs.readFileSync(cachePath, 'utf-8'))
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc as { video?: { path?: unknown } } : null
  } catch {
    return null
  }
}

function docBelongsToVideo(doc: { video?: { path?: unknown } } | null, videoPath: string): boolean {
  return typeof doc?.video?.path === 'string' && normalizedVideoPath(doc.video.path) === normalizedVideoPath(videoPath)
}

export function cacheBelongsToVideo(cachePath: string, videoPath: string): boolean {
  return docBelongsToVideo(readCacheObject(cachePath), videoPath)
}

function modifiedTime(cachePath: string): number {
  try {
    return fs.statSync(cachePath).mtimeMs
  } catch {
    return -Infinity
  }
}

/**
 * Cache location for reads: prefer the currently configured location; when both valid copies exist, use the newest edit (ties prefer the setting).
 * (Existing analysis results remain available after the user changes the cache location, including for opening and counting highlights.)
 * Writes and reanalysis always use `cacheFilePath`, matching the location the engine will write to.
 */
export function resolveCacheFile(videoPath: string, cacheDir: string, beside: boolean): string {
  const preferred = cacheFilePath(videoPath, cacheDir, beside)
  const legacy = legacyCacheFilePath(videoPath, cacheDir, true)
  const other = cacheFilePath(videoPath, cacheDir, !beside)
  const candidates = beside
    ? [[preferred, false], [legacy, true], [other, false]] as const
    : [[preferred, false], [other, false], [legacy, true]] as const
  // Each candidate is read once; ownership is derived from the parsed document.
  const valid = candidates.flatMap(([candidate, oldName]) => {
    const doc = readCacheObject(candidate)
    if (!doc) return []
    const owned = docBelongsToVideo(doc, videoPath)
    return !oldName || owned ? [{ candidate, owned }] : []
  })
  if (valid.length === 0) return preferred
  const sameVideo = valid.filter((v) => v.owned).map((v) => v.candidate)
  if (sameVideo.length === 0) return valid[0].candidate
  // shortcut: mtime orders copies; use explicit revisions if external sync must preserve conflicting edits.
  return sameVideo.reduce((best, current) => modifiedTime(current) > modifiedTime(best) ? current : best)
}
