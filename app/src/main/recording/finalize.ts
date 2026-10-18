import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import type { LiveMatch, PostRecordAnalysis, RecordingMode } from '../../shared/recording'
import type { RecordingDeps } from './index'
import { isTrusted, writeLiveCache, type LiveFile } from './live-cache'
import { finalizeObsSession } from './obs-finalize'

export interface SessionSnapshot {
  startedAt: number
  postAnalysis: PostRecordAnalysis
  mode: RecordingMode
}

export interface IndexEntry { seq: number; pts: number; dur: number }
interface Finalized {
  outputPath: string
  postAnalysis: PostRecordAnalysis
  analysisQueued: boolean
  /** live.json 已嘗試轉成分析快取（第 3 期；舊 marker 缺省＝未轉） */
  liveCached?: boolean
  /** 即時結果等同離線分析，不排完整分析 */
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

/** 僅能刪除 .sessions 的直接子目錄，拒絕 junction／符號連結。 */
export async function validateSessionDir(dir: string): Promise<string> {
  const resolved = path.resolve(dir)
  const parent = path.dirname(resolved)
  if (path.basename(parent) !== '.sessions' ||
      (await fs.promises.lstat(parent)).isSymbolicLink() ||
      (await fs.promises.lstat(resolved)).isSymbolicLink() ||
      !(await fs.promises.stat(resolved)).isDirectory()) {
    throw new Error(`錄影工作目錄無效：${resolved}`)
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
      throw new Error(`錄影索引第 ${i + 1} 行無效：${String(error)}`)
    }
    if (!entry || !Number.isSafeInteger(entry.seq) || entry.seq <= (entries.at(-1)?.seq ?? 0) ||
        !Number.isFinite(entry.pts) || entry.pts < 0 || !Number.isFinite(entry.dur) || entry.dur <= 0) {
      throw new Error(`錄影索引第 ${i + 1} 行的序號或時間無效`)
    }
    entries.push(entry)
  }
  return entries
}

async function snapshot(dir: string, fallback: PostRecordAnalysis): Promise<SessionSnapshot> {
  try {
    const value = JSON.parse(await fs.promises.readFile(path.join(dir, 'recording.json'), 'utf8'))
    if (!Number.isFinite(value.startedAt) || !['none', 'afterExit', 'perMatch'].includes(value.postAnalysis)) {
      throw new Error('錄影設定快照無效')
    }
    return { ...value, mode: value.mode === 'match' ? 'match' : 'session' }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const meta = JSON.parse(await fs.promises.readFile(path.join(dir, 'session.json'), 'utf8'))
  const startedAt = Date.parse(meta.started_at)
  if (!Number.isFinite(startedAt)) throw new Error('錄影開始時間無效')
  return { startedAt, postAnalysis: fallback, mode: 'session' }
}

export const MATCH_PRE_PAD_SEC = 5
export const MATCH_POST_PAD_SEC = 5

/** 以完整段落保留對局前後五秒，只選取與範圍相交的已錄段落。 */
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

interface MatchMarker { cuts: MatchCut[] }

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

function outputInDir(outputPath: string, outputDir: string): boolean {
  return typeof outputPath === 'string' && path.dirname(path.resolve(outputPath)) === outputDir &&
    path.extname(outputPath).toLowerCase() === '.mp4' && !outputPath.endsWith('.part.mp4')
}

async function validateCut(cut: MatchCut, outputDir: string): Promise<void> {
  if (!outputInDir(cut.outputPath, outputDir) || !(await fs.promises.lstat(cut.outputPath)).isFile()) {
    throw new Error('逐局影片路徑無效或檔案遺失')
  }
}

/** 預留檔記在工作目錄，補收尾只清除此工作的暫存檔，不碰其他錄影。 */
export async function resumeMatchPart(dir: string, marker: { cuts: { outputPath: string }[] }): Promise<void> {
  const file = path.join(dir, 'match-part.json')
  const pending = await readOptional<{ output: string; part: string }>(file)
  if (!pending) return
  if (!outputInDir(pending.output, path.dirname(path.dirname(dir))) || pending.part !== pending.output.slice(0, -4) + '.part.mp4') {
    throw new Error('逐局暫存影片路徑無效')
  }
  if (marker.cuts.some((cut) => cut.outputPath === pending.output) && !fs.existsSync(pending.output)) {
    const stat = await fs.promises.lstat(pending.part)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('逐局暫存影片不是一般檔案')
    await fs.promises.rename(pending.part, pending.output)
  } else {
    await fs.promises.unlink(pending.part).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
  }
  await fs.promises.unlink(file)
}

async function remuxMatch(dir: string, deps: RecordingDeps, config: SessionSnapshot, marker: MatchMarker,
  index: number, match: { start: number; end: number }, entries: IndexEntry[]
): Promise<MatchCut> {
  const outputDir = path.dirname(path.dirname(dir))
  const { output, part } = await reserveOutput(outputDir, outputBase(config.startedAt + entries[0].pts * 1000))
  const pending = path.join(dir, 'match-part.json')
  let recorded = false
  try {
    await writeJson(pending, { output, part })
    await remux(deps.ffmpegPath, segmentPaths(dir, entries), part)
    if (fs.existsSync(output)) throw new Error(`輸出影片已存在：${output}`)
    const cut: MatchCut = { index, ...match, firstSeq: entries[0].seq, lastSeq: entries.at(-1)!.seq,
      outputPath: output, analysisQueued: false, liveCached: false, liveTrusted: false }
    // marker 先落盤才改名；中斷後可續用暫存檔，不會留下沒有登記的正式影片。
    await writeJson(path.join(dir, 'matches.json'), { cuts: [...marker.cuts, cut] })
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

function segmentPaths(dir: string, entries: readonly IndexEntry[]): string[] {
  return [path.join(dir, 'init.mp4'), ...entries.map((entry) => path.join(dir, `seg_${String(entry.seq).padStart(6, '0')}.m4s`))]
}

async function completeCut(dir: string, deps: RecordingDeps, config: SessionSnapshot, marker: MatchMarker,
  cut: MatchCut, entries: IndexEntry[], finishing: boolean, trusted: boolean
): Promise<void> {
  await validateCut(cut, path.dirname(path.dirname(dir)))
  deps.addToLibrary([cut.outputPath])
  if (!cut.liveCached || (finishing && trusted && !cut.liveTrusted)) {
    try {
      const summary = await writeLiveCache(dir, cut.outputPath, deps, entries, {
        forceUntrusted: !finishing, overwriteLive: finishing && trusted
      })
      if (summary) deps.onLiveAnalysis?.(cut.outputPath, summary)
    } catch (error) {
      console.error('[recording] 無法把逐局即時事件轉成分析快取：', error)
    }
    cut.liveCached = true
  }
  if (finishing && trusted) cut.liveTrusted = true
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

/** 呼叫端須序列化；錄影中的失敗留待收尾重試，不影響擷取或即時播放。 */
export async function cutMatches(dir: string, deps: RecordingDeps, options: MatchCutOptions = {}): Promise<string[]> {
  const finishing = options.finishing === true
  dir = await validateSessionDir(dir)
  const config = await snapshot(dir, deps.getSettings().postAnalysis)
  if (config.mode !== 'match') return []
  const entries = await readIndex(dir)
  const live = await readOptional<LiveFile>(path.join(dir, 'live.json'))
  const matches = liveMatches(live)
  const last = entries.at(-1)
  if (finishing && last && matches.at(-1)?.end === null) {
    matches[matches.length - 1] = { start: matches.at(-1)!.start, end: last.pts + last.dur }
    await writeJson(path.join(dir, 'live.json'), { ...live, matches })
  }
  const marker = await readOptional<MatchMarker>(path.join(dir, 'matches.json')) ?? { cuts: [] }
  if (!Array.isArray(marker.cuts)) throw new Error('逐局剪檔紀錄無效')
  await resumeMatchPart(dir, marker)
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
    if (marker.cuts.some((cut) => cut.index === index) || (!finishing && options.failed?.has(index))) continue
    const end = match.end
    if (end === null || (!finishing && !entries.some((entry) => entry.pts >= end + MATCH_POST_PAD_SEC))) continue
    const range = selectMatchEntries(entries, match.start, end)
    if (!range.length) continue
    try {
      const cut = await remuxMatch(dir, deps, config, marker, index, { start: match.start, end }, range)
      await completeCut(dir, deps, config, marker, cut, range, finishing, trusted)
      outputs.push(cut.outputPath)
      options.onCut?.(cut.outputPath)
    } catch (error) {
      cutError(index, error, options)
      // 已登記但改名失敗時須先恢復暫存檔，避免下一局覆蓋本工作的預留紀錄。
      await resumeMatchPart(dir, marker)
    }
  }
  return outputs
}

export function outputBase(startedAt: number): string {
  const date = new Date(startedAt)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `Apex_${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}`
}

export async function reserveOutput(outputDir: string, base: string): Promise<{ output: string; part: string }> {
  for (let n = 1; ; n++) {
    const output = path.join(outputDir, `${base}${n === 1 ? '' : `_${n}`}.mp4`)
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

async function remux(ffmpeg: string, files: string[], output: string): Promise<void> {
  const proc = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'mp4', '-i', 'pipe:0',
    '-map', '0', '-c', 'copy', '-movflags', '+faststart', output], { windowsHide: true, stdio: 'pipe' })
  let stderr = Buffer.alloc(0)
  proc.stdout.resume()
  proc.stderr.on('data', (chunk: Buffer) => { stderr = Buffer.concat([stderr, chunk]).subarray(-65536) })
  const exited = new Promise<void>((resolve, reject) => {
    proc.once('error', reject)
    proc.once('close', (code) => code === 0 ? resolve() : reject(
      new Error(`錄影串接失敗（${code}）：${stderr.toString('utf8')}`)))
  })
  async function* chunks(): AsyncGenerator<Buffer> {
    for (const file of files) {
      const stat = await fs.promises.lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`錄影段落不是一般檔案：${file}`)
      for await (const chunk of fs.createReadStream(file)) yield chunk as Buffer
    }
  }
  try { await Promise.all([pipeline(Readable.from(chunks()), proc.stdin), exited]) }
  catch (error) {
    proc.kill()
    await exited.catch(() => {})
    throw new Error(`錄影串接失敗：${stderr.toString('utf8') || String(error)}`)
  }
}

/** finalized.json 先於媒體庫／分析副作用落盤，補收尾不會重複產生影片。 */
export async function finalizeSession(dir: string, deps: RecordingDeps): Promise<string[]> {
  dir = await validateSessionDir(dir)
  const recording = await readOptional<{ backend?: unknown }>(path.join(dir, 'recording.json'))
  if (recording?.backend === 'obs') return finalizeObsSession(dir, deps, await snapshot(dir, deps.getSettings().postAnalysis))
  const outputDir = path.dirname(path.dirname(dir))
  const markerPath = path.join(dir, 'finalized.json')
  let marker: Finalized | null = null
  try { marker = JSON.parse(await fs.promises.readFile(markerPath, 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (!marker) {
    const entries = await readIndex(dir)
    if (entries.length === 0) {
      await fs.promises.rm(dir, { recursive: true })
      return []
    }
    const config = await snapshot(dir, deps.getSettings().postAnalysis)
    if (config.mode === 'match') {
      const live = await readOptional<LiveFile>(path.join(dir, 'live.json'))
      const outputs = await cutMatches(dir, deps, { finishing: true })
      const matches = await readOptional<MatchMarker>(path.join(dir, 'matches.json'))
      if (liveMatches(live).length && matches?.cuts.length) {
        await fs.promises.rm(dir, { recursive: true })
        return outputs
      }
    }
    const { output, part } = await reserveOutput(outputDir, outputBase(config.startedAt))
    try {
      await remux(deps.ffmpegPath, [path.join(dir, 'init.mp4'), ...entries.map(
        (entry) => path.join(dir, `seg_${String(entry.seq).padStart(6, '0')}.m4s`))], part)
      await fs.promises.access(output).then(() => {
        throw new Error(`輸出影片已存在：${output}`)
      }, (error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
      await fs.promises.rename(part, output)
      marker = { outputPath: output, postAnalysis: config.postAnalysis, analysisQueued: false }
      await writeJson(markerPath, marker)
    } catch (error) {
      await fs.promises.unlink(part).catch(() => {})
      throw error
    }
  }
  if (typeof marker.outputPath !== 'string' || path.dirname(path.resolve(marker.outputPath)) !== outputDir ||
      path.extname(marker.outputPath).toLowerCase() !== '.mp4' ||
      !(await fs.promises.lstat(marker.outputPath)).isFile()) throw new Error('已收尾的影片路徑無效或檔案遺失')
  // 舊 marker 只存輸出路徑時，依合約只補加媒體庫，不重排分析。
  if (marker.postAnalysis === undefined) marker.postAnalysis = 'none'
  if (!['none', 'afterExit', 'perMatch'].includes(marker.postAnalysis)) throw new Error('已收尾的分析設定無效')
  deps.addToLibrary([marker.outputPath])
  if (!marker.liveCached) {
    // 即時事件只是加分項：轉換失敗不阻擋收尾（完整分析或之後手動分析會補上）。
    try {
      const summary = await writeLiveCache(dir, marker.outputPath, deps)
      if (summary) deps.onLiveAnalysis?.(marker.outputPath, summary)
      // 即時結果等同離線分析：不再排完整分析（使用者仍可手動重新分析）。
      if (summary?.trusted) marker.liveTrusted = true
    } catch (error) {
      console.error('[recording] 無法把即時事件轉成分析快取：', error)
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
