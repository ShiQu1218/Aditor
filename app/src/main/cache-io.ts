import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

/** 讀取快取 JSON；不存在或損毀回傳 null。內容原樣回傳（含 Clip.status），遷移由 renderer 的 normalizeClips 處理。 */
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

/** 原子寫入（tmp + rename）。 */
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

/** 與引擎 cache.py 的 cache_path 一致：sha1(abspath 小寫、斜線正規化) 命名於快取資料夾。 */
export function cacheFilePath(videoPath: string, cacheDir: string): string {
  const key = crypto.createHash('sha1').update(path.resolve(videoPath).toLowerCase().replace(/\\/g, '/')).digest('hex')
  return path.join(cacheDir, `${key}.json`)
}
