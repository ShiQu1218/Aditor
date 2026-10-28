import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import type { LiveMatch, PostRecordAnalysis, RecordingMode } from '../../shared/recording'
import type { RecordingDeps } from './index'
import { isTrusted, writeLiveCache, type LiveFile } from './live-cache'
import { finalizeObsSession } from './obs-finalize'
import { tr } from '../../shared/locale'
import { DAY_FOLDER_PATTERN, dayFolderName } from '../../shared/storage'
import { DEFAULT_GAME, GAMES, gameOf, type GameId } from '../../shared/games'
import { outputWasRemoved } from './removed-output'

export interface SessionSnapshot {
  startedAt: number
  postAnalysis: PostRecordAnalysis
  mode: RecordingMode
  gameAspect?: string | null
  /** Absent in recordings made before multi-game support (Apex). */
  game?: GameId
}

export interface IndexEntry { seq: number; pts: number; dur: number }
interface Finalized {
  outputPath: string
  postAnalysis: PostRecordAnalysis
  analysisQueued: boolean
  /** Whether live.json has been converted to an analysis cache (phase 3; absent in older markers means not converted). */
  liveCached?: boolean
  /** Live results are equivalent to offline analysis, so do not enqueue a full analysis. */
  liveTrusted?: boolean
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  const temp = file + '.tmp'
  const handle = await fs.promises.open(temp, 'w')
  try {
    await handle.writeFile(JSON.stringify(value), 'utf8')
    await handle.sync()
  } finally { await handle.close() }
  await fs.promises.rename(temp, file)
}

/** Delete only direct children of .sessions; reject junctions and symbolic links. */
export async function validateSessionDir(dir: string): Promise<string> {
  const resolved = path.resolve(dir)
  const parent = path.dirname(resolved)
  if (path.basename(parent) !== '.sessions' ||
      (await fs.promises.lstat(parent)).isSymbolicLink() ||
      (await fs.promises.lstat(resolved)).isSymbolicLink() ||
      !(await fs.promises.stat(resolved)).isDirectory()) {
    throw new Error(tr('錄影工作目錄無效：{resolved}', { resolved }))
  }
  return resolved
}

export async function readIndex(dir: string): Promise<IndexEntry[]> {
  let text: string
  try { text = await fs.promises.readFile(path.join(dir, 'index.jsonl'), 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const lines = text.split('\n')
  const entries: IndexEntry[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue
    let entry: IndexEntry
    try { entry = JSON.parse(lines[i]) }
    catch (error) {
      if (i === lines.length - 1) break
      throw new Error(tr('錄影索引第 {line} 行無效：{error}', { line: i + 1, error: String(error) }))
    }
    if (!entry || !Number.isSafeInteger(entry.seq) || entry.seq <= (entries.at(-1)?.seq ?? 0) ||
        !Number.isFinite(entry.pts) || entry.pts < 0 || !Number.isFinite(entry.dur) || entry.dur <= 0) {
      throw new Error(tr('錄影索引第 {line} 行的序號或時間無效', { line: i + 1 }))
    }
    entries.push(entry)
  }
  return entries
}

async function snapshot(dir: string, fallback: PostRecordAnalysis): Promise<SessionSnapshot> {
  try {
    const value = JSON.parse(await fs.promises.readFile(path.join(dir, 'recording.json'), 'utf8'))
    if (!Number.isFinite(value.startedAt) || !['none', 'afterExit', 'perMatch'].includes(value.postAnalysis)) {
      throw new Error(tr('錄影設定快照無效'))
    }
    return { ...value, mode: value.mode === 'match' ? 'match' : 'session', game: gameOf(value.game) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const meta = JSON.parse(await fs.promises.readFile(path.join(dir, 'session.json'), 'utf8'))
  const startedAt = Date.parse(meta.started_at)
  if (!Number.isFinite(startedAt)) throw new Error(tr('錄影開始時間無效'))
  return { startedAt, postAnalysis: fallback, mode: 'session' }
}

export const MATCH_PRE_PAD_SEC = 5
export const MATCH_POST_PAD_SEC = 5

/** Keep complete segments covering five seconds before and after a match; select only recorded segments intersecting the range. */
export function selectMatchEntries(entries: readonly IndexEntry[], start: number, end: number): IndexEntry[] {
  return entries.filter((entry) => entry.pts + entry.dur > start - MATCH_PRE_PAD_SEC && entry.pts < end + MATCH_POST_PAD_SEC)
}

interface MatchCut {
  index: number
  start: number
  end: number
  firstSeq: number
  lastSeq: number
  outputPath: string
  analysisQueued: boolean
  liveCached: boolean
  liveTrusted: boolean
}

interface MatchMarker { cuts: MatchCut[]; skipped?: number[] }

interface MatchCutOptions {
  finishing?: boolean
  failed?: Set<number>
  onCut?: (outputPath: string) => void
  onError?: (error: unknown) => void
}

function cutError(index: number, error: unknown, options: MatchCutOptions): void {
  if (!options.onError) throw error
  options.failed?.add(index)
  options.onError(error)
}

export async function readOptional<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await fs.promises.readFile(file, 'utf8')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** The output file must be directly under outputDir (legacy) or outputDir/<YYYY-MM-DD>/. */
export function inOutputDir(outputPath: unknown, outputDir: string): boolean {
  if (typeof outputPath !== 'string') return false
  const parent = path.dirname(path.resolve(outputPath))
  const root = path.resolve(outputDir)
  return parent === root || (path.dirname(parent) === root && DAY_FOLDER_PATTERN.test(path.basename(parent)))
}

function outputInDir(outputPath: string, outputDir: string): boolean {
  return inOutputDir(outputPath, outputDir) &&
    path.extname(outputPath).toLowerCase() === '.mp4' && !outputPath.endsWith('.part.mp4')
}

async function validateCut(cut: MatchCut, outputDir: string): Promise<void> {
  if (!outputInDir(cut.outputPath, outputDir) || !(await fs.promises.lstat(cut.outputPath)).isFile()) {
    throw new Error(tr('逐局影片路徑無效或檔案遺失'))
  }
}

/**
 * The reserved file is recorded in the work directory; recovery removes only this session's temporary file.
 * Returns the output path when the reservation is stale (the marker lists it, but both the output and the part
 * are gone), so the caller can drop the marker entry and finalize again from the segments.
 */
export async function resumeMatchPart(dir: string, marker: { cuts: { outputPath: string }[] }): Promise<string | null> {
  const file = path.join(dir, 'match-part.json')
  const pending = await readOptional<{ output: string; part: string }>(file)
  if (!pending) return null
  if (!outputInDir(pending.output, path.dirname(path.dirname(dir))) || pending.part !== pending.output.slice(0, -4) + '.part.mp4') {
    throw new Error(tr('逐局暫存影片路徑無效'))
  }
  if (marker.cuts.some((cut) => cut.outputPath === pending.output) && !fs.existsSync(pending.output)) {
    let stat: fs.Stats | null = null
    try {
      stat = await fs.promises.lstat(pending.part)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (!stat) {
      // Keep the reservation until the caller has persisted removal of the stale marker.
      return pending.output
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(tr('逐局暫存影片不是一般檔案'))
    await fs.promises.rename(pending.part, pending.output)
  } else {
    await fs.promises.unlink(pending.part).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
  }
  await fs.promises.unlink(file)
  return null
}

/** Drop a cut whose reservation cannot be completed so the match is cut again from its segments. */
async function dropStaleCut(dir: string, marker: MatchMarker, outputPath: string): Promise<void> {
  const cuts = marker.cuts.filter((cut) => cut.outputPath !== outputPath)
  if (cuts.length === marker.cuts.length) return
  marker.cuts = cuts
  await writeJson(path.join(dir, 'matches.json'), marker)
  await resumeMatchPart(dir, marker)
}

async function remuxMatch(dir: string, deps: RecordingDeps, config: SessionSnapshot, marker: MatchMarker,
  index: number, match: { start: number; end: number }, entries: IndexEntry[]
): Promise<MatchCut> {
  const outputDir = path.dirname(path.dirname(dir))
  const { output, part } = await reserveOutput(outputDir, outputBase(config.startedAt + entries[0].pts * 1000, config.game), config.startedAt + entries[0].pts * 1000)
  const pending = path.join(dir, 'match-part.json')
  let recorded = false
  try {
    await writeJson(pending, { output, part })
    for (const file of segmentPaths(dir, entries)) {
      const stat = await fs.promises.lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(tr('逐局剪檔缺少有效片段：{file}', { file }))
    }
    await remux(deps.ffmpegPath, segmentPaths(dir, entries), part, config)
    if (fs.existsSync(output)) throw new Error(tr('輸出影片已存在：{output}', { output }))
    const cut: MatchCut = { index, ...match, firstSeq: entries[0].seq, lastSeq: entries.at(-1)!.seq,
      outputPath: output, analysisQueued: false, liveCached: false, liveTrusted: false }
    // Persist the marker before renaming so recovery can reuse the temporary file without leaving an unregistered final video.
    await writeJson(path.join(dir, 'matches.json'), { ...marker, cuts: [...marker.cuts, cut] })
    marker.cuts.push(cut)
    recorded = true
    await fs.promises.rename(part, output)
    await fs.promises.unlink(pending)
    return cut
  } catch (error) {
    if (!recorded) {
      await fs.promises.unlink(part).catch(() => {})
      await fs.promises.unlink(pending).catch(() => {})
    }
    throw error
  }
}

function segmentPath(dir: string, seq: number): string {
  return path.join(dir, `seg_${String(seq).padStart(6, '0')}.m4s`)
}

function segmentPaths(dir: string, entries: readonly IndexEntry[]): string[] {
  return [path.join(dir, 'init.mp4'), ...entries.map((entry) => segmentPath(dir, entry.seq))]
}

/** Drop indexed segments whose files are gone (for example removed by antivirus or a sync client) so the rest can still be output with a gap. */
async function presentEntries(dir: string, entries: readonly IndexEntry[]): Promise<{ present: IndexEntry[]; missing: number }> {
  const present: IndexEntry[] = []
  for (const entry of entries) {
    const file = segmentPath(dir, entry.seq)
    let stat: fs.Stats
    try { stat = await fs.promises.lstat(file) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(tr('錄影段落不是一般檔案：{file}', { file }))
    present.push(entry)
  }
  return { present, missing: entries.length - present.length }
}

function reportMissing(deps: RecordingDeps, missing: number, output: string): void {
  if (missing <= 0) return
  const message = tr('有 {count} 個錄影段落檔案遺失（可能被防毒或同步程式移除），已略過缺少的部分並輸出：{output}',
    { count: missing, output: path.basename(output) })
  try { deps.log?.(`notice warning: ${message}`) } catch { /* Diagnostic logging must not affect finalization. */ }
  deps.notify('warning', message)
}

async function completeCut(dir: string, deps: RecordingDeps, config: SessionSnapshot, marker: MatchMarker,
  cut: MatchCut, entries: IndexEntry[], finishing: boolean, trusted: boolean
): Promise<void> {
  if (outputWasRemoved(dir, cut.outputPath)) return
  try { await validateCut(cut, path.dirname(path.dirname(dir))) }
  catch (error) { if (outputWasRemoved(dir, cut.outputPath)) return; throw error }
  if (outputWasRemoved(dir, cut.outputPath)) return
  addRecorded(deps, [cut.outputPath], config.game)
  if (!cut.liveCached || (finishing && trusted && !cut.liveTrusted)) {
    try {
      const summary = await writeLiveCache(dir, cut.outputPath, deps, entries, {
        forceUntrusted: !finishing, overwriteLive: finishing && trusted
      })
      if (summary) {
        deps.onLiveAnalysis?.(cut.outputPath, summary)
        cut.liveCached = true
        cut.liveTrusted = summary.trusted
      }
    } catch (error) {
      console.error('[recording] Failed to convert per-match live events into an analysis cache:', error)
    }
  }
  await writeJson(path.join(dir, 'matches.json'), marker)
  if (!cut.analysisQueued && (config.postAnalysis === 'perMatch' ||
      (finishing && config.postAnalysis === 'afterExit' && !cut.liveTrusted))) {
    deps.enqueueAnalysis(cut.outputPath)
    cut.analysisQueued = true
    await writeJson(path.join(dir, 'matches.json'), marker)
  }
}

export function liveMatches(live: LiveFile | null): LiveMatch[] {
  if (!Array.isArray(live?.matches)) return []
  return live.matches.filter((match): match is LiveMatch => !!match && Number.isFinite(match.start) && match.start >= 0 &&
    (match.end === null || (Number.isFinite(match.end) && match.end >= match.start)))
}

/** Callers must serialize this operation. Failures during recording are retried at finalization and do not affect capture or live playback. */
export async function cutMatches(dir: string, deps: RecordingDeps, options: MatchCutOptions = {}): Promise<string[]> {
  const finishing = options.finishing === true
  dir = await validateSessionDir(dir)
  const config = await snapshot(dir, deps.getSettings().postAnalysis)
  if (config.mode !== 'match') return []
  const entries = await readIndex(dir)
  const live = await readOptional<LiveFile>(path.join(dir, 'live.json'))
  const matches = liveMatches(live)
  const retainedFrom = live?.retained_from
  const retainedEntries = typeof retainedFrom === 'number' && Number.isFinite(retainedFrom) && retainedFrom >= 0
    ? entries.filter(entry => entry.pts >= retainedFrom) : entries
  const last = entries.at(-1)
  if (finishing && last && matches.at(-1)?.end === null) {
    matches[matches.length - 1] = { start: matches.at(-1)!.start, end: last.pts + last.dur }
    await writeJson(path.join(dir, 'live.json'), { ...live, matches })
  }
  const marker = await readOptional<MatchMarker>(path.join(dir, 'matches.json')) ?? { cuts: [] }
  if (!Array.isArray(marker.cuts) || (marker.skipped !== undefined && !Array.isArray(marker.skipped))) {
    throw new Error(tr('逐局剪檔紀錄無效'))
  }
  const stale = await resumeMatchPart(dir, marker)
  if (stale) await dropStaleCut(dir, marker, stale)
  const trusted = finishing && !!live && isTrusted(live)
  for (const cut of marker.cuts) {
    if (!finishing && (options.failed?.has(cut.index) ||
        (cut.liveCached && (config.postAnalysis !== 'perMatch' || cut.analysisQueued)))) continue
    const range = entries.filter((entry) => entry.seq >= cut.firstSeq && entry.seq <= cut.lastSeq)
    try { await completeCut(dir, deps, config, marker, cut, range, finishing, trusted) }
    catch (error) { cutError(cut.index, error, options) }
  }
  const outputs: string[] = []
  for (const [index, match] of matches.entries()) {
    if (marker.cuts.some((cut) => cut.index === index) || marker.skipped?.includes(index) ||
        (!finishing && options.failed?.has(index))) continue
    const end = match.end
    if (end === null || (!finishing && !entries.some((entry) => entry.pts >= end + MATCH_POST_PAD_SEC))) continue
    const { present: range, missing } = await presentEntries(dir, selectMatchEntries(retainedEntries, match.start, end))
    if (!range.length) {
      if (finishing && missing > 0) {
        marker.skipped = [...(marker.skipped ?? []), index]
        await writeJson(path.join(dir, 'matches.json'), marker)
        deps.notify('warning', tr('第 {index} 局的錄影片段檔案全部遺失，已略過此局', { index: index + 1 }))
      } else {
        cutError(index, new Error(tr('對局範圍沒有錄影片段，已保留工作')), options)
      }
      continue
    }
    try {
      const cut = await remuxMatch(dir, deps, config, marker, index, { start: match.start, end }, range)
      reportMissing(deps, missing, cut.outputPath)
      await completeCut(dir, deps, config, marker, cut, range, finishing, trusted)
      outputs.push(cut.outputPath)
      options.onCut?.(cut.outputPath)
    } catch (error) {
      cutError(index, error, options)
      // If the marker was written but rename failed, restore the temporary file before the next match can overwrite this reservation.
      const stale = await resumeMatchPart(dir, marker)
      if (stale) await dropStaleCut(dir, marker, stale)
    }
  }
  return outputs
}

export function outputBase(startedAt: number, game?: GameId): string {
  const date = new Date(startedAt)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${GAMES[gameOf(game)].filePrefix}_${dayFolderName(startedAt)}_${pad(date.getHours())}-${pad(date.getMinutes())}`
}

/** Place output in `<outputDir>/<local start date>/`; check `_2`, `_3`, and similar collisions within that date folder. */
export async function reserveOutput(outputDir: string, base: string, startedAt: number): Promise<{ output: string; part: string }> {
  const dayDir = path.join(outputDir, dayFolderName(startedAt))
  await fs.promises.mkdir(dayDir, { recursive: true })
  for (let n = 1; ; n++) {
    const output = path.join(dayDir, `${base}${n === 1 ? '' : `_${n}`}.mp4`)
    try { await fs.promises.access(output); continue } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const part = output.slice(0, -4) + '.part.mp4'
    try {
      const handle = await fs.promises.open(part, 'wx')
      await handle.close()
      return { output, part }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}

/** Add finished outputs with the recorded game; Apex stays untagged, as its MP4s do. */
export function addRecorded(deps: RecordingDeps, paths: string[], game?: GameId): void {
  if (game && game !== DEFAULT_GAME) deps.addToLibrary(paths, game)
  else deps.addToLibrary(paths)
}

/** MP4 tags the engine reads back for offline analysis; Apex recordings stay untagged for the game, as before. */
export function gameMetadataArgs(config: { gameAspect?: string | null; game?: GameId }): string[] {
  const tags = [
    ...(config.gameAspect ? [`aditor_game_aspect=${config.gameAspect}`] : []),
    ...(config.game && config.game !== DEFAULT_GAME ? [`aditor_game=${config.game}`] : [])
  ]
  return [...tags.flatMap((tag) => ['-metadata', tag]), '-movflags', tags.length ? '+faststart+use_metadata_tags' : '+faststart']
}

async function remux(ffmpeg: string, files: string[], output: string, config: SessionSnapshot): Promise<void> {
  const proc = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'mp4', '-i', 'pipe:0',
    '-map', '0', '-c', 'copy', ...gameMetadataArgs(config), output],
  { windowsHide: true, stdio: 'pipe' })
  let stderr = Buffer.alloc(0)
  proc.stdout.resume()
  proc.stderr.on('data', (chunk: Buffer) => { stderr = Buffer.concat([stderr, chunk]).subarray(-65536) })
  const exited = new Promise<void>((resolve, reject) => {
    proc.once('error', reject)
    proc.once('close', (code) => code === 0 ? resolve() : reject(
      new Error(tr('錄影串接失敗（{code}）：{stderr}', { code, stderr: stderr.toString('utf8') }))))
  })
  async function* chunks(): AsyncGenerator<Buffer> {
    for (const file of files) {
      const stat = await fs.promises.lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(tr('錄影段落不是一般檔案：{file}', { file }))
      for await (const chunk of fs.createReadStream(file)) yield chunk as Buffer
    }
  }
  try { await Promise.all([pipeline(Readable.from(chunks()), proc.stdin), exited]) }
  catch (error) {
    proc.kill()
    await exited.catch(() => {})
    throw new Error(tr('錄影串接失敗：{stderr}', { stderr: stderr.toString('utf8') || String(error) }))
  }
}

/** Marker indicating live detection stayed healthy until stop (written by live-session). */
export const LIVE_COMPLETE_FILE = 'live-complete.json'

/** Persist finalized.json before library/analysis side effects so recovery does not generate the video twice. */
export async function finalizeSession(dir: string, deps: RecordingDeps): Promise<string[]> {
  dir = await validateSessionDir(dir)
  const recording = await readOptional<{ backend?: unknown; livePending?: unknown; game?: unknown }>(path.join(dir, 'recording.json'))
  if (recording?.backend === 'obs') return finalizeObsSession(dir, deps, await snapshot(dir, deps.getSettings().postAnalysis))
  const outputDir = path.dirname(path.dirname(dir))
  const markerPath = path.join(dir, 'finalized.json')
  let marker: Finalized | null = null
  try { marker = JSON.parse(await fs.promises.readFile(markerPath, 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (marker) {
    const stale = await resumeMatchPart(dir, { cuts: [marker] })
    if (stale === marker.outputPath) {
      // The reserved part was deleted before its rename: drop the marker and finalize again from the segments below.
      await fs.promises.unlink(markerPath)
      marker = null
    }
  }
  if (!marker) {
    const entries = await readIndex(dir)
    if (entries.length === 0) {
      await fs.promises.rm(dir, { recursive: true })
      return []
    }
    const config = await snapshot(dir, deps.getSettings().postAnalysis)
    // An interrupted live write may leave an older, non-empty match list. Preserve all available footage instead.
    if (config.mode === 'match' && recording?.livePending !== true && !fs.existsSync(path.join(dir, 'live.json.tmp'))) {
      const live = await readOptional<LiveFile>(path.join(dir, 'live.json'))
      const outputs = await cutMatches(dir, deps, { finishing: true })
      const matches = await readOptional<MatchMarker>(path.join(dir, 'matches.json'))
      const detected = liveMatches(live)
      if (detected.length) {
        if (!matches?.cuts.length && !detected.every((_, index) => matches?.skipped?.includes(index))) {
          throw new Error(tr('對局沒有可剪出的片段，已保留工作'))
        }
        await fs.promises.rm(dir, { recursive: true })
        return outputs
      }
      // Only a healthy completion proves that no-match footage was lobby-only; pruning alone can precede an engine failure.
      if (Array.isArray(live?.matches) && await readOptional(path.join(dir, LIVE_COMPLETE_FILE))) {
        await fs.promises.rm(dir, { recursive: true })
        return []
      }
    }
    // Incomplete detection falls through to the available segments below.
    const { present, missing } = await presentEntries(dir, entries)
    if (!present.length) throw new Error(tr('錄影段落檔案全部遺失，無法輸出影片，已保留工作'))
    // Drop a part left by an attempt that crashed before its marker was written.
    await resumeMatchPart(dir, { cuts: [] })
    const { output, part } = await reserveOutput(outputDir, outputBase(config.startedAt, config.game), config.startedAt)
    const pending = path.join(dir, 'match-part.json')
    let recorded = false
    try {
      // Same order as per-match cuts: persist the reservation and marker before the rename, so recovery finishes it instead of remuxing again.
      await writeJson(pending, { output, part })
      await remux(deps.ffmpegPath, segmentPaths(dir, present), part, config)
      await fs.promises.access(output).then(() => {
        throw new Error(tr('輸出影片已存在：{output}', { output }))
      }, (error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
      marker = { outputPath: output, postAnalysis: config.postAnalysis, analysisQueued: false }
      await writeJson(markerPath, marker)
      recorded = true
      await fs.promises.rename(part, output)
      await fs.promises.unlink(pending)
      reportMissing(deps, missing, output)
    } catch (error) {
      if (!recorded) {
        await fs.promises.unlink(part).catch(() => {})
        await fs.promises.unlink(pending).catch(() => {})
      }
      throw error
    }
  }
  if (!inOutputDir(marker.outputPath, outputDir) ||
      path.extname(marker.outputPath).toLowerCase() !== '.mp4' ||
      !(await fs.promises.lstat(marker.outputPath)).isFile()) throw new Error(tr('已收尾的影片路徑無效或檔案遺失'))
  // Legacy markers store only the output path; recovery adds the file to the library without re-enqueuing analysis.
  if (marker.postAnalysis === undefined) marker.postAnalysis = 'none'
  if (!['none', 'afterExit', 'perMatch'].includes(marker.postAnalysis)) throw new Error(tr('已收尾的分析設定無效'))
  // recording.json outlives the marker, so recovery keeps the game even without a live cache.
  addRecorded(deps, [marker.outputPath], gameOf(recording?.game))
  if (!marker.liveCached) {
      // Live events are best-effort: conversion failure does not block finalization; full or manual analysis can fill them in later.
    try {
      // Align the cache with the first segment actually in the output when leading segments went missing; use the full index if no segment files remain.
      const { present } = await presentEntries(dir, await readIndex(dir))
      const summary = await writeLiveCache(dir, marker.outputPath, deps, present.length ? present : undefined, {
        forceUntrusted: recording?.livePending === true || fs.existsSync(path.join(dir, 'live.json.tmp'))
      })
      if (summary) deps.onLiveAnalysis?.(marker.outputPath, summary)
      // Live results are equivalent to offline analysis, so do not enqueue a full analysis (the user can still reanalyze manually).
      if (summary?.trusted) marker.liveTrusted = true
    } catch (error) {
      console.error('[recording] Failed to convert live events into an analysis cache:', error)
    }
    marker.liveCached = true
    await writeJson(markerPath, marker)
  }
  if (!marker.analysisQueued && marker.postAnalysis !== 'none' && !marker.liveTrusted) {
    deps.enqueueAnalysis(marker.outputPath)
    marker.analysisQueued = true
    await writeJson(markerPath, marker)
  }
  await fs.promises.rm(dir, { recursive: true })
  return [marker.outputPath]
}
