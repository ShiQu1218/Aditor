/**
 * Finalization converts the recording's `live.json` into an analysis cache for the output video
 * (matching the engine's `analyze.py` `_make_doc` format), so the studio still has events when post-recording analysis is disabled.
 *
 * Set `analysis.status = "done"` (the studio and library recognize only `done`), but deliberately
 * write `engine_version` as `live-<version>`. The engine's `cache.needs_reanalysis` reruns analysis
 * when `engine_version != ENGINE_VERSION`, so queued and manual full analyses still run and replace
 * this cache, while preserving the usual merge behavior for user edits to events.
 */
import fs from 'fs'
import path from 'path'
import { countEvents, type EngineEvent } from '../../shared/types'
import { DEFAULT_GAME, gameOf, gameProfileDir, type GameId } from '../../shared/games'
import { readIndex, type IndexEntry } from './finalize'
import { LIVE_FILE } from './live-session'
import { codecName, initCodecs } from './mp4-codec'
import type { LiveAnalysisSummary, RecordingDeps } from './index'

export interface LiveFile {
  engine_version?: unknown
  events?: unknown
  spectating?: unknown
  matches?: unknown
  /** Earliest retained segment PTS after pruning; excludes deleted pre-pad from match cuts. */
  retained_from?: unknown
  width?: unknown
  height?: unknown
  quality?: unknown
}

/** Offset has the same direction as segment PTS: cache time = live time - offset. */
export interface LiveCacheRange { offset: number; duration: number; width?: number; height?: number; codec?: string }

/** The live engine result is equivalent to offline analysis and includes an engine version for the cache. */
export function isTrusted(live: LiveFile): boolean {
  const q = live.quality as { complete?: unknown } | null | undefined
  return !!q && q.complete === true && typeof live.engine_version === 'string' && live.engine_version.length > 0
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function liveCounts(events: EngineEvent[]): LiveAnalysisSummary['counts'] {
  return countEvents(events)
}

/** Build the cache document from live.json, shifting time to the output video (first segment = 0) and keeping only in-range events. */
export function buildLiveCacheDoc(live: LiveFile, video: {
  path: string; size: number; mtime: number; duration: number; width: number; height: number; codec: string
}, offset: number, templatesVersion: string, cachePath: string, game: GameId = DEFAULT_GAME): Record<string, unknown> & { events: EngineEvent[] } {
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
    .filter((m): m is { start: number; end: number | null } => !!m && finite(m.start) &&
      (m.end === null || (finite(m.end) && m.end >= m.start)))
    .filter((m) => m.start <= offset + video.duration && (m.end === null || m.end >= offset))
    .map((m) => ({ start: Math.max(0, m.start - offset), end: m.end === null ? null : Math.min(video.duration, m.end - offset) }))
  const version = typeof live.engine_version === 'string' ? live.engine_version : 'unknown'
  const trusted = isTrusted(live)
  const quality = live.quality as { hScale?: unknown; aspectSquash?: unknown } | null | undefined
  const hScale = quality?.hScale
  // Offline analysis keys its cache on the game aspect; caches without the field are 16:9.
  const squash = trusted && finite(quality?.aspectSquash) && quality.aspectSquash !== 1 ? { aspect_squash: quality.aspectSquash } : {}
  return {
    version: 1,
    video: { ...video, start_time: 0 },
    analysis: {
      status: 'done', source: 'live', progress_t: video.duration,
      // Trusted results use the official engine version so needs_reanalysis treats them as complete; otherwise the `live-` prefix lets full analysis replace them.
      engine_version: trusted ? version : `live-${version}`, templates_version: templatesVersion,
      h_scale: trusted && finite(hScale) ? hScale : 1, ...squash
    },
    events,
    spectating,
    clips: [],
    // Engine-unknown field; discarded when full analysis rewrites the cache.
    live: { matches },
    cache_path: cachePath,
    // Apex caches stay without the field, as before.
    ...(game === DEFAULT_GAME ? {} : { game })
  }
}

async function templatesVersion(profileDir: string): Promise<string> {
  try {
    const profile = JSON.parse(await fs.promises.readFile(path.join(profileDir, 'profile.json'), 'utf8'))
    return typeof profile.templates_version === 'string' ? profile.templates_version : ''
  } catch { return '' }
}

/** Game from the session's recording.json; sessions recorded before multi-game support are Apex. */
async function recordedGame(dir: string): Promise<GameId> {
  try { return gameOf(JSON.parse(await fs.promises.readFile(path.join(dir, 'recording.json'), 'utf8')).game) }
  catch { return DEFAULT_GAME }
}

async function canWriteLiveCache(cachePath: string, overwriteLive: boolean): Promise<boolean> {
  if (!fs.existsSync(cachePath)) return true
  if (!overwriteLive) return false
  const existing = JSON.parse(await fs.promises.readFile(cachePath, 'utf8'))
  return existing?.analysis?.source === 'live'
}

/**
 * Write a live cache for the requested segment range (the full recording by default). Trusted
 * finalization may overwrite only its own live cache. Skip when live.json or a cache location is
 * unavailable; callers may force an untrusted result during recording. Return the written summary
 * for the library, or null when skipped.
 */
export async function writeLiveCache(dir: string, outputPath: string, deps: RecordingDeps,
  range?: readonly IndexEntry[] | LiveCacheRange, options: { forceUntrusted?: boolean; overwriteLive?: boolean } = {}
): Promise<LiveAnalysisSummary | null> {
  if (!deps.liveCachePath) return null
  let live: LiveFile
  try { live = JSON.parse(await fs.promises.readFile(path.join(dir, LIVE_FILE), 'utf8')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (options.forceUntrusted) live = { ...live, quality: null }
  const cachePath = deps.liveCachePath(outputPath)
  if (!await canWriteLiveCache(cachePath, !!options.overwriteLive)) return null
  const explicit = range && 'offset' in range ? range : null
  const entries = explicit ? [] : (range as readonly IndexEntry[] | undefined) ?? await readIndex(dir)
  if (!explicit && entries.length === 0) return null
  const offset = explicit ? explicit.offset : entries[0].pts
  const last = entries.at(-1)
  const duration = explicit ? explicit.duration : last!.pts + last!.dur - offset
  let codec = explicit?.codec ?? ''
  if (!explicit) {
    try { codec = codecName(initCodecs(new Uint8Array(await fs.promises.readFile(path.join(dir, 'init.mp4'))))) }
    catch { /* Unknown codec; the engine will fill it in during full analysis. */ }
  }
  const game = await recordedGame(dir)
  const stat = await fs.promises.stat(outputPath)
  const size = (v: unknown): number => (Number.isSafeInteger(v) && Number(v) > 0 ? Number(v) : 0)
  const doc = buildLiveCacheDoc(live, {
    path: outputPath, size: stat.size, mtime: stat.mtimeMs / 1000, duration,
    width: size(explicit?.width ?? live.width), height: size(explicit?.height ?? live.height), codec
  }, offset, await templatesVersion(gameProfileDir(deps.profileDir, game)), cachePath, game)
  await fs.promises.mkdir(path.dirname(cachePath), { recursive: true })
  // Full analysis uses .tmp; live cache uses a separate temporary file to avoid concurrent writes clobbering each other.
  const temp = `${cachePath}.live.tmp`
  try {
    await fs.promises.writeFile(temp, JSON.stringify(doc), 'utf8')
    if (!await canWriteLiveCache(cachePath, !!options.overwriteLive)) return null
    await fs.promises.rename(temp, cachePath)
  } finally { await fs.promises.unlink(temp).catch(() => {}) }
  return { counts: liveCounts(doc.events), durationSec: duration, codec, trusted: isTrusted(live), game }
}
