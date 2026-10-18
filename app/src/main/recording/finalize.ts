import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import type { PostRecordAnalysis } from '../../shared/recording'
import type { RecordingDeps } from './index'

export interface SessionSnapshot {
  startedAt: number
  postAnalysis: PostRecordAnalysis
}

interface IndexEntry { seq: number; pts: number; dur: number }
interface Finalized { outputPath: string; postAnalysis: PostRecordAnalysis; analysisQueued: boolean }

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
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const meta = JSON.parse(await fs.promises.readFile(path.join(dir, 'session.json'), 'utf8'))
  const startedAt = Date.parse(meta.started_at)
  if (!Number.isFinite(startedAt)) throw new Error('錄影開始時間無效')
  return { startedAt, postAnalysis: fallback }
}

function outputBase(startedAt: number): string {
  const date = new Date(startedAt)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `Apex_${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}`
}

async function reserveOutput(outputDir: string, base: string): Promise<{ output: string; part: string }> {
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
  if (!marker.analysisQueued && marker.postAnalysis !== 'none') {
    deps.enqueueAnalysis(marker.outputPath)
    marker.analysisQueued = true
    await writeJson(markerPath, marker)
  }
  await fs.promises.rm(dir, { recursive: true })
  return [marker.outputPath]
}
