import { mergeOnReanalyze } from '../shared/clips'
import type { CacheDoc, Clip } from '../shared/types'
import fs from 'fs'
import path from 'path'
import { cacheFilePath, loadCacheDoc, saveCacheDoc } from './cache-io'

/** 片段備份檔：與快取同資料夾的 `<sha1>.clips.json`。 */
export function clipsBackupPath(cachePath: string): string {
  return cachePath.replace(/\.json$/i, '') + '.clips.json'
}

/** 讀備份；不存在、損毀或形狀不符一律回 null（呼叫端退回快取文件的片段）。 */
export function readClipsBackup(cachePath: string): Clip[] | null {
  try {
    const data = JSON.parse(fs.readFileSync(clipsBackupPath(cachePath), 'utf-8'))
    return data && data.version === 1 && Array.isArray(data.clips) ? (data.clips as Clip[]) : null
  } catch {
    return null
  }
}

/** 原子寫入備份（tmp＋fsync＋rename）；失敗只記錄並回傳 false。 */
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

/** 分析開始前對既有快取的唯讀快照（只讀；絕不寫回）。 */
export interface PriorCache {
  clips: Clip[]
  /** 舊文件分析是否已完成（partial＝首次分析被中斷後接續，不算「重新分析」） */
  done: boolean
  /** 供判斷「引擎直接回傳快取（命中）」：video＋analysis 完全相同＝沒有重新分析 */
  fingerprint: string
}

const fingerprintOf = (doc: Partial<CacheDoc>): string => JSON.stringify([doc.video ?? null, doc.analysis ?? null])

/**
 * 分析前呼叫：讀取既有快取並維護片段備份。
 * - 快取文件 `done`：把它的片段寫成備份（覆寫舊備份；重新分析期間引擎會用只剩手動片段的文件蓋掉快取）。
 * - 快取文件 `partial`（上次被取消／中斷）：保留既有備份不動，繼續使用備份裡的片段。
 * - 備份優先於（可能不完整的）文件片段；備份損毀＝忽略。
 * 沒有快取也沒有備份＝null（首次分析）。
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
 * 分析**成功**完成後呼叫。引擎的 `merge_clips` 只保留手動片段並覆寫快取，所以重新分析時
 * 由 main 補回：clips ＝ `mergeOnReanalyze(舊片段, [])`（手動保留；已加入的 AI 片段保留並標 stale；
 * 建議／略過丟棄），並設 `app.suggestionsPending = true`，工作室開啟時據此重算建議（只做一次）。
 *
 * 不處理的情況（回傳 false，快取維持引擎寫的樣子）：首次分析（沒有舊快取）、舊文件未完成、
 * 新結果未完成、引擎直接回傳快取（video／analysis 與分析前相同＝命中，不是重新分析）。
 * 取消／失敗不會呼叫本函式：備份原封不動留在快取旁，之後的續跑／重跑會繼續使用它
 * （引擎在取消前就已把快取覆寫成只剩手動片段的 partial）。
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
    // 引擎直接回傳快取：沒有發生重新分析，剛建立的備份已無用
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
  // 只有改寫成功才刪備份；失敗保留，下次還能用
  if (ok) deleteClipsBackup(cachePath)
  return ok
}
