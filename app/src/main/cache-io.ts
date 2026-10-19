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
 * beside ⇒ `<video directory>/<filename stem>.aditor.json`; otherwise, use the lowercase, slash-normalized abspath's SHA-1 in the cache directory.
 */
export function cacheFilePath(videoPath: string, cacheDir: string, beside = false): string {
  if (beside) {
    const v = path.parse(videoPath)
    return path.join(v.dir, `${v.name}.aditor.json`)
  }
  const key = crypto.createHash('sha1').update(path.resolve(videoPath).toLowerCase().replace(/\\/g, '/')).digest('hex')
  return path.join(cacheDir, `${key}.json`)
}

/**
 * Cache location for reads: prefer the currently configured location; if its file is missing and the other location has one, use the other.
 * (Existing analysis results remain available after the user changes the cache location, including for opening and counting highlights.)
 * Writes and reanalysis always use `cacheFilePath`, matching the location the engine will write to.
 */
export function resolveCacheFile(videoPath: string, cacheDir: string, beside: boolean): string {
  const preferred = cacheFilePath(videoPath, cacheDir, beside)
  if (fs.existsSync(preferred)) return preferred
  const other = cacheFilePath(videoPath, cacheDir, !beside)
  return fs.existsSync(other) ? other : preferred
}
