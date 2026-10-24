import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import type { RecordingDeps } from './index'
import type { ObsMatch, ObsMetadata } from './obs-session'
import { ALLOWED_VIDEO_EXTS, isSafeLocalDirPath } from '../safe-path'
import { addRecorded, MATCH_POST_PAD_SEC, MATCH_PRE_PAD_SEC, inOutputDir, liveMatches, outputBase, readOptional, reserveOutput,
  resumeMatchPart, writeJson, gameMetadataArgs, type SessionSnapshot } from './finalize'
import { isTrusted, writeLiveCache, type LiveCacheRange, type LiveFile } from './live-cache'
import { createCutLookup, createMediaEndProbe } from '../export/keyframe'
import { ObsClient } from './obs-client'
import { copyCutArgs } from '../export/plan'
import type { ProjectItem } from '../../renderer/editor/project'
import { tr } from '../../shared/locale'
import { outputWasRemoved } from './removed-output'

interface ObsOutput extends LiveCacheRange {
  outputPath: string
  index: number
  analysisQueued: boolean
  liveCached: boolean
  liveTrusted: boolean
}

function localVideoPath(file: unknown): file is string {
  return isSafeLocalDirPath(file) && !/^[\\/]{2}/.test(file) && ALLOWED_VIDEO_EXTS.has(path.extname(file).toLowerCase())
}

async function localFile(file: unknown): Promise<boolean> {
  if (!localVideoPath(file)) return false
  try { await fs.promises.access(file, fs.constants.R_OK); return (await fs.promises.stat(file)).isFile() }
  catch { return false }
}

/** A missing local file is permanently deleted only when its volume and parent folder still exist; an offline drive or unmounted folder may come back. */
async function permanentlyDeleted(file: string): Promise<boolean> {
  try { await fs.promises.stat(file); return false }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false }
  try {
    await fs.promises.stat(path.parse(file).root)
    return (await fs.promises.stat(path.dirname(file))).isDirectory()
  } catch { return false }
}

/**
 * Read the OBS source without modifying it; reserve the output temporary file exclusively with
 * reserveOutput. Return the actual source start time in seconds. Stream copy must start at a keyframe:
 * using `-ss` at the cut point starts video at the previous keyframe while audio starts at the cut,
 * and the MP4 edit list hides the gap. Chromium playback can then drift by one keyframe interval,
 * so find the keyframe first and cut from there, as the export path does.
 */
async function copyMatch(ffmpeg: string, source: string, part: string, start: number, end: number, config: SessionSnapshot): Promise<number> {
  const cut = await createCutLookup(ffprobePath(ffmpeg))({ source, start, end })
  const aligned = cut && Number.isFinite(cut.keyframe) && cut.keyframe <= start && cut.keyframe >= 0 ? cut.keyframe : null
  const args = copyCutArgs({ source, start, end } as ProjectItem, cut, part)
    // Preserve all OBS audio tracks; move the MP4 index to the front for faster playback during download and faster studio opening.
    .map((arg) => (arg === '0:a:0?' ? '0:a?' : arg))
  args.splice(args.lastIndexOf('-y'), 0, ...gameMetadataArgs(config))
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = Buffer.alloc(0)
    proc.stderr.on('data', (chunk: Buffer) => { stderr = Buffer.concat([stderr, chunk]).subarray(-65536) })
    proc.once('error', reject)
    proc.once('close', (code) => code === 0 ? resolve() : reject(new Error(tr('OBS 逐局剪檔失敗（{code}）：{stderr}', { code, stderr: stderr.toString('utf8') }))))
  })
  return aligned ?? start
}

function ffprobePath(ffmpeg: string): string {
  return path.join(path.dirname(ffmpeg), `ffprobe${process.platform === 'win32' ? '.exe' : ''}`)
}

/** Maximum wait after OBS stops while it finishes writing the file (MKV writes total duration to the header last). */
const OBS_FILE_SETTLE_TOTAL_MS = 60_000
const OBS_FILE_SETTLE_STEP_MS = 1000

/** Treat OBS as finished only when duration is readable and file size is unchanged twice in a row. */
async function settledProbe<T extends { duration?: number | null }>(file: string, probe: () => Promise<T>, stepMs: number): Promise<T> {
  let lastSize = -1
  let last: T | null = null
  for (let waited = 0; ; waited += stepMs) {
    const size = (await fs.promises.stat(file)).size
    try { last = await probe() } catch { last = null }
    const ready = typeof last?.duration === 'number' && Number.isFinite(last.duration) && last.duration > 0
    if (ready && size === lastSize) return last!
    if (waited >= OBS_FILE_SETTLE_TOTAL_MS) {
      if (ready) return last!
      throw new Error(tr('無法取得 OBS 影片長度（OBS 可能仍在寫入），已保留工作供下次補收尾'))
    }
    lastSize = size
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

/** obs.json is the recovery source of truth; having zero segments does not mean there is no OBS video. */
export async function finalizeObsSession(dir: string, deps: RecordingDeps, config: SessionSnapshot): Promise<string[]> {
  const recordedMatches = await readOptional<ObsMatch[]>(path.join(dir, 'obs-matches.json'))
  if (recordedMatches) return finalizeObsMatches(dir, deps, config, recordedMatches, true)
  const meta = await readOptional<ObsMetadata>(path.join(dir, 'obs.json'))
  if (!meta?.outputPath || !await localFile(meta.outputPath)) {
    // A local path that is unreadable right now (drive offline, file locked) may come back; keep live.json for a retry.
    if (localVideoPath(meta?.outputPath)) {
      // A file deleted from an accessible folder never comes back; do not keep retrying it on every startup.
      if (await permanentlyDeleted(meta.outputPath)) {
        deps.notify('warning', tr('OBS 影片已不存在，已移除這次錄影的收尾工作'))
        await fs.promises.rm(dir, { recursive: true })
        return []
      }
      throw new Error(tr('OBS 影片暫時無法讀取，已保留工作供下次補收尾'))
    }
    deps.notify('warning', tr('OBS 影片不是可讀取的本機檔案，未加入媒體庫；請在 OBS 主機確認並手動匯入'))
    await fs.promises.rm(dir, { recursive: true })
    return []
  }
  if (![meta.recordStartedAt, meta.captureStartedAt].every(Number.isFinite)) throw new Error(tr('OBS 時間對齊資料無效'))
  const source = await fs.promises.realpath(meta.outputPath)
  const relative = path.relative(await fs.promises.realpath(dir), source)
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) throw new Error(tr('OBS 原檔位於錄影工作目錄內，已保留原檔與工作目錄'))
  const probe = createMediaEndProbe(path.join(path.dirname(deps.ffmpegPath), `ffprobe${process.platform === 'win32' ? '.exe' : ''}`))
  const info = await settledProbe(meta.outputPath, async () => deps.probeVideo
    ? await deps.probeVideo(meta.outputPath!) : { duration: await probe(meta.outputPath!) }, deps.obsFileSettleMs ?? OBS_FILE_SETTLE_STEP_MS)
  const { duration, ...video } = info
  if (!duration) throw new Error(tr('無法取得 OBS 影片長度，已保留工作供下次補收尾'))
  const offset = (meta.recordStartedAt - meta.captureStartedAt) / 1000
  const live = await readOptional<LiveFile>(path.join(dir, 'live.json'))
  const matches = liveMatches(live)
  const markerFile = path.join(dir, config.mode === 'match' && matches.length ? 'matches.json' : 'obs-finalized.json')
  const marker = await readOptional<{ cuts: ObsOutput[] }>(markerFile) ?? { cuts: [] }
  if (!Array.isArray(marker.cuts)) throw new Error(tr('OBS 收尾紀錄無效'))
  const outputDir = path.dirname(path.dirname(dir))
  if (config.mode === 'match' && matches.length) {
    const pending = await readOptional<{ part: string; output: string }>(path.join(dir, 'match-part.json'))
    if (pending && [pending.part, pending.output].some((file) => path.resolve(file).toLowerCase() === source.toLowerCase())) {
      throw new Error(tr('逐局暫存紀錄與 OBS 原檔重疊，已保留原檔'))
    }
    const stale = await resumeMatchPart(dir, marker)
    if (stale) {
      marker.cuts = marker.cuts.filter((cut) => cut.outputPath !== stale)
      await writeJson(markerFile, marker)
      await resumeMatchPart(dir, marker)
    }
    for (const [index, match] of matches.entries()) {
      if (marker.cuts.some((cut) => cut.index === index)) continue
      const start = Math.max(0, match.start - offset - MATCH_PRE_PAD_SEC)
      const end = Math.min(duration, (match.end === null ? duration : match.end - offset) + MATCH_POST_PAD_SEC)
      if (end <= start) continue
      const { output, part } = await reserveOutput(outputDir, outputBase(meta.recordStartedAt + start * 1000, config.game), meta.recordStartedAt + start * 1000)
      let recorded = false
      try {
        await writeJson(path.join(dir, 'match-part.json'), { output, part })
        const actualStart = await copyMatch(deps.ffmpegPath, meta.outputPath, part, start, end, config)
        if (fs.existsSync(output)) throw new Error(tr('逐局輸出路徑已存在'))
        // Limit the cache to the actual duration; stream-copy cuts land on a nearby keyframe.
        const cutDuration = await probe(part)
        if (!cutDuration) throw new Error(tr('無法取得逐局影片長度'))
        marker.cuts.push({ index, outputPath: output, offset: offset + actualStart, duration: cutDuration, ...video,
          analysisQueued: false, liveCached: false, liveTrusted: false })
        await writeJson(markerFile, marker)
        recorded = true
        await fs.promises.rename(part, output)
        await fs.promises.unlink(path.join(dir, 'match-part.json'))
      } catch (error) {
        if (!recorded) {
          await fs.promises.unlink(part).catch(() => {})
          await fs.promises.unlink(path.join(dir, 'match-part.json')).catch(() => {})
        }
        throw error
      }
    }
  }
  // Preserve the full recording when a match falls outside the source time range to avoid losing footage.
  if (!marker.cuts.length) {
    marker.cuts.push({ index: 0, outputPath: meta.outputPath, offset, duration, ...video,
      analysisQueued: false, liveCached: false, liveTrusted: false })
    await writeJson(markerFile, marker)
  }
  for (const cut of marker.cuts) {
    if (outputWasRemoved(dir, cut.outputPath)) continue
    const original = cut.outputPath === meta.outputPath
    if ((!original && !inOutputDir(cut.outputPath, outputDir)) || !await localFile(cut.outputPath)) throw new Error(tr('OBS 收尾影片路徑無效'))
    addRecorded(deps, [cut.outputPath], config.game)
    if (!cut.liveCached) {
      try {
        const summary = await writeLiveCache(dir, cut.outputPath, deps, cut)
        if (summary) { deps.onLiveAnalysis?.(cut.outputPath, summary); cut.liveTrusted = summary.trusted }
      } catch (error) { console.error('[recording] Failed to write OBS live event cache:', error) }
      cut.liveCached = true
      await writeJson(markerFile, marker)
    }
    if (!cut.analysisQueued && !cut.liveTrusted && config.postAnalysis !== 'none') {
      deps.enqueueAnalysis(cut.outputPath)
      cut.analysisQueued = true
      await writeJson(markerFile, marker)
    }
  }
  const outputs = marker.cuts.filter((cut) => !outputWasRemoved(dir, cut.outputPath)).map((cut) => cut.outputPath)
  await fs.promises.rm(dir, { recursive: true })
  return outputs
}

export class ObsRecoveryPending extends Error {}

/** Add per-match source files to the library directly; keep the marker until the entire session finalizes successfully. */
export async function finalizeObsMatches(dir: string, deps: RecordingDeps, config: SessionSnapshot,
  matches: ObsMatch[], finishing: boolean, save?: () => Promise<void>, metadata?: ObsMetadata): Promise<string[]> {
  if (!Array.isArray(matches) || matches.some((match) => !match || !Number.isSafeInteger(match.index) || !Number.isFinite(match.recordStartedAt))) {
    throw new Error(tr('OBS 逐局錄影紀錄無效'))
  }
  const meta = metadata ?? await readOptional<ObsMetadata>(path.join(dir, 'obs.json'))
  if (!meta || !Number.isFinite(meta.captureStartedAt)) throw new Error(tr('OBS 擷取起點無效'))
  const persist = (): Promise<void> => save ? save() : writeJson(path.join(dir, 'obs-matches.json'), matches)
  for (const match of matches) {
    if (match.stopped || !finishing) continue
    const client = new ObsClient()
    try {
      const settings = deps.getSettings()
      await client.connect(settings.obsHost, settings.obsPort, deps.getObsPassword?.())
      const status = await client.status()
      // OBS v5 status has no path; compare the current recording duration with the start time to avoid stopping a user-started recording.
      if (status.outputActive) {
        if (!Number.isFinite(status.outputDuration) || Math.abs(Date.now() - status.outputDuration - match.recordStartedAt) > 3000) {
          throw new Error(tr('無法確認 OBS 錄影歸屬，請在 OBS 確認並停止錄影'))
        }
        match.outputPath = await client.stop()
      }
      if (!match.outputPath && !match.cancelled && match.confirmed !== false) throw new Error(tr('OBS 停止路徑遺失，請手動匯入並確認錄影'))
      match.stopped = true
      await persist()
    } catch (error) {
      deps.notify('warning', tr('OBS 逐局錄影尚未完成，已保留工作供下次啟動重試'))
      throw new ObsRecoveryPending(String(error))
    } finally { await client.close() }
  }
  const live = await readOptional<LiveFile>(path.join(dir, 'live.json'))
  const trusted = finishing && !!live && isTrusted(live)
  const outputs: string[] = []
  for (const match of matches) {
    if (match.confirmed === false && match.stopped && !match.cancelled) {
      match.cancelled = true
      await persist()
    }
    if (match.cancelled) continue
    if (!match.stopped && !finishing) continue
    if (!match.stopped || !match.outputPath) throw new Error(tr('OBS 逐局影片尚未完成'))
    const file = match.outputPath
    if (outputWasRemoved(dir, file)) continue
    if (!await localFile(file)) throw new Error(tr('OBS 逐局影片不是可讀取的本機檔案'))
    const relative = path.relative(await fs.promises.realpath(dir), await fs.promises.realpath(file))
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) throw new Error(tr('OBS 原檔位於錄影工作目錄內'))
    if (!match.added || !match.liveCached || (trusted && !match.liveTrusted)) {
      const info = await settledProbe(file, async () => deps.probeVideo
        ? deps.probeVideo(file) : { duration: await createMediaEndProbe(ffprobePath(deps.ffmpegPath))(file) }, deps.obsFileSettleMs ?? OBS_FILE_SETTLE_STEP_MS)
      if (!info.duration) throw new Error(tr('無法取得 OBS 影片長度'))
      if (!match.added) {
        addRecorded(deps, [file], config.game)
        match.added = true
        await persist()
        outputs.push(file)
      }
      const summary = await writeLiveCache(dir, file, deps, { ...info, duration: info.duration,
        offset: (match.recordStartedAt - meta.captureStartedAt) / 1000 }, { forceUntrusted: !finishing, overwriteLive: trusted })
      if (summary) { deps.onLiveAnalysis?.(file, summary); match.liveTrusted = summary.trusted }
      match.liveCached = true
      await persist()
    }
    if (!match.analysisQueued && !match.liveTrusted && (config.postAnalysis === 'perMatch' || (finishing && config.postAnalysis === 'afterExit'))) {
      deps.enqueueAnalysis(file); match.analysisQueued = true; await persist()
    }
  }
  if (finishing) await fs.promises.rm(dir, { recursive: true })
  return outputs
}
