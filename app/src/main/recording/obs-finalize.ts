import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import type { RecordingDeps } from './index'
import type { ObsMetadata } from './obs-session'
import { ALLOWED_VIDEO_EXTS, isSafeLocalDirPath } from '../safe-path'
import { MATCH_POST_PAD_SEC, MATCH_PRE_PAD_SEC, liveMatches, outputBase, readOptional, reserveOutput,
  resumeMatchPart, writeJson, type SessionSnapshot } from './finalize'
import { writeLiveCache, type LiveCacheRange, type LiveFile } from './live-cache'
import { createMediaEndProbe } from '../export/keyframe'

interface ObsOutput extends LiveCacheRange {
  outputPath: string
  index: number
  analysisQueued: boolean
  liveCached: boolean
  liveTrusted: boolean
}

async function localFile(file: unknown): Promise<boolean> {
  if (!isSafeLocalDirPath(file) || /^[\\/]{2}/.test(file) || !ALLOWED_VIDEO_EXTS.has(path.extname(file).toLowerCase())) return false
  try { await fs.promises.access(file, fs.constants.R_OK); return (await fs.promises.stat(file)).isFile() }
  catch { return false }
}

/** 只讀 OBS 來源；剪出的暫存檔由 reserveOutput 獨占預留。 */
async function copyMatch(ffmpeg: string, source: string, part: string, start: number, end: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(start), '-to', String(end),
      '-i', source, '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-movflags', '+faststart', part],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = Buffer.alloc(0)
    proc.stderr.on('data', (chunk: Buffer) => { stderr = Buffer.concat([stderr, chunk]).subarray(-65536) })
    proc.once('error', reject)
    proc.once('close', (code) => code === 0 ? resolve() : reject(new Error(`OBS 逐局剪檔失敗（${code}）：${stderr.toString('utf8')}`)))
  })
}

/** obs.json 是復原依據；零段落不代表沒有 OBS 影片。 */
export async function finalizeObsSession(dir: string, deps: RecordingDeps, config: SessionSnapshot): Promise<string[]> {
  const meta = await readOptional<ObsMetadata>(path.join(dir, 'obs.json'))
  if (!meta?.outputPath || !await localFile(meta.outputPath)) {
    deps.notify('warning', 'OBS 影片不是可讀取的本機檔案，未加入媒體庫；請在 OBS 主機確認並手動匯入')
    await fs.promises.rm(dir, { recursive: true })
    return []
  }
  if (![meta.recordStartedAt, meta.captureStartedAt].every(Number.isFinite)) throw new Error('OBS 時間對齊資料無效')
  const source = await fs.promises.realpath(meta.outputPath)
  const relative = path.relative(await fs.promises.realpath(dir), source)
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) throw new Error('OBS 原檔位於錄影工作目錄內，已保留原檔與工作目錄')
  const probe = createMediaEndProbe(path.join(path.dirname(deps.ffmpegPath), `ffprobe${process.platform === 'win32' ? '.exe' : ''}`))
  const info = deps.probeVideo ? await deps.probeVideo(meta.outputPath) : { duration: await probe(meta.outputPath) }
  const { duration, ...video } = info
  if (!duration || !Number.isFinite(duration) || duration <= 0) throw new Error('無法取得 OBS 影片長度，已保留工作供下次補收尾')
  const offset = (meta.recordStartedAt - meta.captureStartedAt) / 1000
  const live = await readOptional<LiveFile>(path.join(dir, 'live.json'))
  const matches = liveMatches(live)
  const markerFile = path.join(dir, config.mode === 'match' && matches.length ? 'matches.json' : 'obs-finalized.json')
  const marker = await readOptional<{ cuts: ObsOutput[] }>(markerFile) ?? { cuts: [] }
  if (!Array.isArray(marker.cuts)) throw new Error('OBS 收尾紀錄無效')
  const outputDir = path.dirname(path.dirname(dir))
  if (config.mode === 'match' && matches.length) {
    const pending = await readOptional<{ part: string; output: string }>(path.join(dir, 'match-part.json'))
    if (pending && [pending.part, pending.output].some((file) => path.resolve(file).toLowerCase() === source.toLowerCase())) {
      throw new Error('逐局暫存紀錄與 OBS 原檔重疊，已保留原檔')
    }
    await resumeMatchPart(dir, marker)
    for (const [index, match] of matches.entries()) {
      if (marker.cuts.some((cut) => cut.index === index)) continue
      const start = Math.max(0, match.start - offset - MATCH_PRE_PAD_SEC)
      const end = Math.min(duration, (match.end === null ? duration : match.end - offset) + MATCH_POST_PAD_SEC)
      if (end <= start) continue
      const { output, part } = await reserveOutput(outputDir, outputBase(meta.recordStartedAt + start * 1000))
      let recorded = false
      try {
        await writeJson(path.join(dir, 'match-part.json'), { output, part })
        await copyMatch(deps.ffmpegPath, meta.outputPath, part, start, end)
        if (fs.existsSync(output)) throw new Error('逐局輸出路徑已存在')
        // 以實際長度限制快取；stream copy 切點會落在附近關鍵影格。
        const cutDuration = await probe(part)
        if (!cutDuration) throw new Error('無法取得逐局影片長度')
        marker.cuts.push({ index, outputPath: output, offset: offset + start, duration: cutDuration, ...video,
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
  // 對局不在來源時間範圍內時也保留整段，避免遺失錄影。
  if (!marker.cuts.length) {
    marker.cuts.push({ index: 0, outputPath: meta.outputPath, offset, duration, ...video,
      analysisQueued: false, liveCached: false, liveTrusted: false })
    await writeJson(markerFile, marker)
  }
  for (const cut of marker.cuts) {
    const original = cut.outputPath === meta.outputPath
    if ((!original && path.dirname(path.resolve(cut.outputPath)) !== outputDir) || !await localFile(cut.outputPath)) throw new Error('OBS 收尾影片路徑無效')
    deps.addToLibrary([cut.outputPath])
    if (!cut.liveCached) {
      try {
        const summary = await writeLiveCache(dir, cut.outputPath, deps, cut)
        if (summary) { deps.onLiveAnalysis?.(cut.outputPath, summary); cut.liveTrusted = summary.trusted }
      } catch (error) { console.error('[recording] 無法寫入 OBS 即時事件快取：', error) }
      cut.liveCached = true
      await writeJson(markerFile, marker)
    }
    if (!cut.analysisQueued && !cut.liveTrusted && config.postAnalysis !== 'none') {
      deps.enqueueAnalysis(cut.outputPath)
      cut.analysisQueued = true
      await writeJson(markerFile, marker)
    }
  }
  await fs.promises.rm(dir, { recursive: true })
  return marker.cuts.map((cut) => cut.outputPath)
}
