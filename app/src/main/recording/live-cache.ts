/**
 * 收尾：把錄影中的 `live.json` 轉成輸出影片的分析快取（格式同引擎 `analyze.py` 的 `_make_doc`），
 * 讓「錄後分析＝不分析」時工作室也有事件。
 *
 * `analysis.status = "done"`（工作室與媒體庫只認 done），但 `engine_version` 刻意寫成 `live-<版本>`：
 * 引擎 `cache.needs_reanalysis` 比對 `engine_version != ENGINE_VERSION` 即重新分析，
 * 所以「關遊戲後／每局後」排入的完整分析與手動「重新分析」仍會跑完整分析並覆蓋（使用者對事件的修改照常合併）。
 */
import fs from 'fs'
import path from 'path'
import { isCounted, type EngineEvent } from '../../shared/types'
import { readIndex } from './finalize'
import { LIVE_FILE } from './live-session'
import { codecName, initCodecs } from './mp4-codec'
import type { LiveAnalysisSummary, RecordingDeps } from './index'

interface LiveFile {
  engine_version?: unknown
  events?: unknown
  spectating?: unknown
  matches?: unknown
  width?: unknown
  height?: unknown
  quality?: unknown
}

/** live 引擎判定結果等同離線分析，且有引擎版本可寫入快取。 */
export function isTrusted(live: LiveFile): boolean {
  const q = live.quality as { complete?: unknown } | null | undefined
  return !!q && q.complete === true && typeof live.engine_version === 'string' && live.engine_version.length > 0
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function liveCounts(events: EngineEvent[]): LiveAnalysisSummary['counts'] {
  let knock = 0
  let assist = 0
  for (const e of events) {
    if (!isCounted(e)) continue
    if (e.type === 'knock') knock++
    else if (e.type === 'assist_knock' || e.type === 'assist_elim') assist++
  }
  return { knock, assist }
}

/** 由 live.json 內容組出快取文件；時間平移到輸出檔（第一段 = 0），只保留影片範圍內的事件。 */
export function buildLiveCacheDoc(live: LiveFile, video: {
  path: string; size: number; mtime: number; duration: number; width: number; height: number; codec: string
}, offset: number, templatesVersion: string, cachePath: string): Record<string, unknown> & { events: EngineEvent[] } {
  const inRange = (t: number): boolean => t >= 0 && t <= video.duration
  const events = (Array.isArray(live.events) ? live.events : [])
    .filter((e): e is EngineEvent => !!e && typeof e === 'object' && typeof e.id === 'string' && finite(e.t) && typeof e.type === 'string')
    .map((e) => ({ ...e, t: e.t - offset }))
    .filter((e) => inRange(e.t))
    .sort((a, b) => a.t - b.t)
  const spectating = (Array.isArray(live.spectating) ? live.spectating : [])
    .filter((s): s is { start: number; end: number } => !!s && finite(s.start) && finite(s.end) && s.end >= s.start)
    .map((s) => ({ start: Math.max(0, s.start - offset), end: Math.min(video.duration, s.end - offset) }))
    .filter((s) => s.end > s.start)
  const matches = (Array.isArray(live.matches) ? live.matches : [])
    .filter((m): m is { start: number; end: number | null } => !!m && finite(m.start) && (m.end === null || finite(m.end)))
    .map((m) => ({ start: Math.max(0, m.start - offset), end: m.end === null ? null : Math.min(video.duration, m.end - offset) }))
  const version = typeof live.engine_version === 'string' ? live.engine_version : 'unknown'
  const trusted = isTrusted(live)
  const hScale = (live.quality as { hScale?: unknown } | null | undefined)?.hScale
  return {
    version: 1,
    video: { ...video, start_time: 0 },
    analysis: {
      status: 'done', source: 'live', progress_t: video.duration,
      // 可信時寫正式引擎版本：needs_reanalysis 視為已完成，不再重跑；否則 `live-` 前綴讓完整分析照常覆蓋。
      engine_version: trusted ? version : `live-${version}`, templates_version: templatesVersion,
      h_scale: trusted && finite(hScale) ? hScale : 1
    },
    events,
    spectating,
    clips: [],
    // 引擎不認得的欄位；完整分析重寫快取時會被丟棄。
    live: { matches },
    cache_path: cachePath
  }
}

async function templatesVersion(profileDir: string): Promise<string> {
  try {
    const profile = JSON.parse(await fs.promises.readFile(path.join(profileDir, 'profile.json'), 'utf8'))
    return typeof profile.templates_version === 'string' ? profile.templates_version : ''
  } catch { return '' }
}

/**
 * 寫入 live 快取；沒有 live.json、沒有快取位置或該位置已有快取（不覆蓋完整分析）時略過。
 * 回傳寫好的摘要（供媒體庫），略過時 null。
 */
export async function writeLiveCache(dir: string, outputPath: string, deps: RecordingDeps): Promise<LiveAnalysisSummary | null> {
  if (!deps.liveCachePath) return null
  let live: LiveFile
  try { live = JSON.parse(await fs.promises.readFile(path.join(dir, LIVE_FILE), 'utf8')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const cachePath = deps.liveCachePath(outputPath)
  if (fs.existsSync(cachePath)) return null
  const entries = await readIndex(dir)
  if (entries.length === 0) return null
  const offset = entries[0].pts
  const last = entries[entries.length - 1]
  const duration = last.pts + last.dur - offset
  let codec = ''
  try { codec = codecName(initCodecs(new Uint8Array(await fs.promises.readFile(path.join(dir, 'init.mp4'))))) }
  catch { /* 編碼未知：完整分析時引擎會補上 */ }
  const stat = await fs.promises.stat(outputPath)
  const size = (v: unknown): number => (Number.isSafeInteger(v) && Number(v) > 0 ? Number(v) : 0)
  const doc = buildLiveCacheDoc(live, {
    path: outputPath, size: stat.size, mtime: stat.mtimeMs / 1000, duration,
    width: size(live.width), height: size(live.height), codec
  }, offset, await templatesVersion(deps.profileDir), cachePath)
  await fs.promises.mkdir(path.dirname(cachePath), { recursive: true })
  const temp = `${cachePath}.tmp`
  await fs.promises.writeFile(temp, JSON.stringify(doc), 'utf8')
  await fs.promises.rename(temp, cachePath)
  return { counts: liveCounts(doc.events), durationSec: duration, codec, trusted: isTrusted(live) }
}
