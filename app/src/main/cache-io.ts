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

/**
 * 與引擎 cache.py 的 `cache_path(video, cache_dir, beside)` 同一規則：
 * beside ⇒ `<影片資料夾>/<主檔名>.apexhl.json`；否則 sha1(abspath 小寫、斜線正規化) 命名於快取資料夾。
 */
export function cacheFilePath(videoPath: string, cacheDir: string, beside = false): string {
  if (beside) {
    const v = path.parse(videoPath)
    return path.join(v.dir, `${v.name}.apexhl.json`)
  }
  const key = crypto.createHash('sha1').update(path.resolve(videoPath).toLowerCase().replace(/\\/g, '/')).digest('hex')
  return path.join(cacheDir, `${key}.json`)
}

/**
 * 讀取用的快取位置：優先目前設定的位置；那裡沒有檔、另一個位置有 → 用另一個
 * （使用者切換「快取位置」後，既有分析結果仍可開啟／計算精華數）。
 * 寫入／重新分析一律用 `cacheFilePath`（與引擎本次會寫入的位置一致）。
 */
export function resolveCacheFile(videoPath: string, cacheDir: string, beside: boolean): string {
  const preferred = cacheFilePath(videoPath, cacheDir, beside)
  if (fs.existsSync(preferred)) return preferred
  const other = cacheFilePath(videoPath, cacheDir, !beside)
  return fs.existsSync(other) ? other : preferred
}
