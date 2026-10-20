/**
 * Core IPC handlers for exports (no Electron dependency; testable with fake ipcMain/webContents).
 * Channels: `export:start`, `export:cancel`, `export:diskSpace`, `export:checkOutDir`; `export:progress` is sent only to the requesting window.
 */
import fs from 'fs'
import path from 'path'
import { buildJobs, concatList, resolveFreeBaseName, resolveQuality, StreamProbe } from './plan'
import { AudioProbe, createAudioProbe, createCutLookup, createMediaEndProbe, CutLookup, lookupCopyCuts, MediaEndProbe, measureMediaEnds } from './keyframe'
import { runExport, RunExportOptions, RunProgress } from './run'
import { isSafeLocalDirPath, isSafeLocalVideoPath, fileExistsSafe } from '../safe-path'
import { estimateOutputBytes } from '../../shared/exportEstimate'
import { tr } from '../../shared/locale'
import { exportSubDirName } from '../../shared/storage'

export interface ExportSender {
  isDestroyed(): boolean
  send(channel: string, data: RunProgress): void
  /** webContents 'destroyed' event (window closed); caller invokes cancel separately when unavailable. */
  once?(event: 'destroyed', listener: () => void): unknown
  removeListener?(event: 'destroyed', listener: () => void): unknown
}

export interface IpcMainLike {
  handle(channel: string, listener: (event: { sender: ExportSender }, ...args: any[]) => unknown): void
}

export interface ExportServiceDeps {
  /** Get source video metadata (engine probe); use defaults on failure or when unavailable. */
  probe?: (source: string) => Promise<unknown>
  ffmpeg?: RunExportOptions['ffmpeg']
  tempDir?: string
  /** Audio-track query for precise concatenation; add silence first when a source has no audio track. */
  hasAudio?: AudioProbe
  /** Query fast stream-copy cut points (keyframes and end); defaults to a packet-only ffprobe query. */
  copyCut?: CutLookup
  /** For concatenation: measure the actual playback end of an intermediate file; defaults to reading packets with ffprobe. */
  mediaEnd?: MediaEndProbe
}

export interface ValidatedRequest {
  items: Array<{ id: string; source: string; start: number; end: number }>
  mode: 'separate' | 'concat'
  quality: 'copy' | 'precise'
  encoder?: string
  /** User-selected output directory (validated to exist and be writable). */
  outDir: string
  /** Actual output directory: the mode-specific subdirectory under `outDir` (Merged or Clips), created and writable. */
  outputDir: string
  baseName: string
}

class RequestError extends Error {}

const MAX_ITEMS = 2000
const MAX_BASENAME = 100
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** Sanitize a filename stem: remove path separators, Windows-invalid characters, trailing dots/spaces, and reserved names; limit its length; use `export` when empty. */
export function sanitizeBaseName(name: string): string {
  let s = name.replace(/[\x00-\x1f<>:"/\\|?*]/g, '_')
  s = s.replace(/[. ]+$/g, '').replace(/^\s+/, '')
  if (/^\.+$/.test(s)) s = ''
  if (s.length > MAX_BASENAME) s = s.slice(0, MAX_BASENAME).replace(/[. ]+$/g, '')
  if (s.length === 0) return 'export'
  if (RESERVED.test(s.split('.')[0])) s = '_' + s
  return s
}

async function assertWritableDir(dir: string): Promise<void> {
  let st: fs.Stats
  try {
    st = await fs.promises.stat(dir)
  } catch {
    throw new RequestError(tr('輸出資料夾不存在'))
  }
  if (!st.isDirectory()) throw new RequestError(tr('輸出路徑不是資料夾'))
  const probe = path.join(dir, `.aditor-write-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`)
  try {
    await fs.promises.writeFile(probe, '', { flag: 'wx' })
  } catch {
    throw new RequestError(tr('輸出資料夾無法寫入'))
  }
  await fs.promises.rm(probe, { force: true }).catch(() => undefined)
}

export async function validateExportRequest(raw: unknown): Promise<ValidatedRequest> {
  if (typeof raw !== 'object' || raw === null) throw new RequestError(tr('匯出請求格式不正確'))
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.items) || r.items.length === 0) throw new RequestError(tr('沒有可匯出的片段'))
  if (r.items.length > MAX_ITEMS) throw new RequestError(tr('片段數量過多'))
  const items: ValidatedRequest['items'] = []
  for (const it of r.items) {
    if (typeof it !== 'object' || it === null) throw new RequestError(tr('片段格式不正確'))
    const { id, source, start, end } = it as Record<string, unknown>
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)) {
      throw new RequestError(tr('片段時間必須是有限數字'))
    }
    if (start < 0 || end <= start) throw new RequestError(tr('片段時間範圍不正確'))
    if (!isSafeLocalVideoPath(source)) throw new RequestError(tr('來源影片路徑不正確'))
    if (!(await fileExistsSafe(source))) throw new RequestError(tr('找不到來源影片：{source}', { source }))
    items.push({ id: typeof id === 'string' ? id : '', source, start, end })
  }
  if (r.mode !== 'separate' && r.mode !== 'concat') throw new RequestError(tr('匯出模式不正確'))
  if (r.quality !== 'copy' && r.quality !== 'precise') throw new RequestError(tr('匯出品質不正確'))
  let encoder: string | undefined
  if (r.encoder !== undefined && r.encoder !== null) {
    if (typeof r.encoder !== 'string' || !/^[A-Za-z0-9_]{1,40}$/.test(r.encoder)) throw new RequestError(tr('編碼器名稱不正確'))
    encoder = r.encoder
  }
  if (!isSafeLocalDirPath(r.outDir)) throw new RequestError(tr('輸出資料夾路徑不正確'))
  const outDir = path.resolve(r.outDir)
  await assertWritableDir(outDir)
  if (typeof r.baseName !== 'string') throw new RequestError(tr('檔名不正確'))
  // Create the subdirectory only after all other fields pass validation, so invalid requests do not leave empty folders behind.
  const outputDir = path.join(outDir, exportSubDirName(r.mode))
  try {
    await fs.promises.mkdir(outputDir, { recursive: true })
  } catch {
    throw new RequestError(tr('無法建立輸出子資料夾'))
  }
  await assertWritableDir(outputDir)
  return { items, mode: r.mode, quality: r.quality, encoder, outDir, outputDir, baseName: sanitizeBaseName(r.baseName) }
}

/** Defaults when metadata is unavailable: use common codec/resolution values and mark frame rate, pixel format, and audio specs as unknown (0/empty); compatibility checks then remain conservative. */
const DEFAULT_PROBE: StreamProbe = {
  vcodec: 'h264',
  width: 1920,
  height: 1080,
  fps: 0,
  pix_fmt: '',
  acodec: '',
  sample_rate: 0,
  channels: 0
}

const posNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export type ExportStartResult =
  | { ok: true; outputs: string[]; notices: string[] }
  | { ok: false; cancelled: true; outputs: string[]; notices: string[] }
  | { ok: false; cancelled?: false; code?: 'busy'; error: string; outputs: string[]; notices?: string[] }

export function createExportService(deps: ExportServiceDeps = {}) {
  /** Allow one export at a time; set this before any await so two starts in the same tick cannot both pass the check. */
  let current: { ac: AbortController; done: Promise<unknown> } | null = null

  async function start(sender: ExportSender, raw: unknown): Promise<ExportStartResult> {
    if (current) return { ok: false, code: 'busy', error: tr('已有匯出正在進行中，請等待完成或先取消'), outputs: [] }
    const ac = new AbortController()
    let resolveDone!: () => void
    current = { ac, done: new Promise<void>((r) => (resolveDone = r)) }
    const onDestroyed = (): void => {
      ac.abort()
    }
    sender.once?.('destroyed', onDestroyed)
    try {
      const req = await validateExportRequest(raw)
      if (ac.signal.aborted) return { ok: false, cancelled: true, outputs: [], notices: [] }

      const probes = new Map<string, StreamProbe>()
      for (const item of req.items) {
        if (probes.has(item.source)) continue
        let info: StreamProbe = { ...DEFAULT_PROBE }
        if (deps.probe) {
          try {
            const p = (await deps.probe(item.source)) as Record<string, unknown> | null
            if (p) {
              // The engine currently provides only codec/resolution; use any other fields it provides, otherwise keep them unknown.
              info = {
                vcodec: str(p.codec) || 'h264',
                width: posNum(p.width) || 1920,
                height: posNum(p.height) || 1080,
                fps: posNum(p.fps),
                pix_fmt: str(p.pix_fmt),
                acodec: str(p.acodec),
                sample_rate: posNum(p.sample_rate),
                channels: posNum(p.channels)
              }
            }
          } catch {
            // Use defaults when metadata is unavailable.
          }
        }
        probes.set(item.source, info)
      }
      if (ac.signal.aborted) return { ok: false, cancelled: true, outputs: [], notices: [] }

      // Do not overwrite existing files: append " (2)" to a duplicate name (I6).
      const free = resolveFreeBaseName(req.outputDir, req.baseName, req.mode, req.items.length, (p) => fs.existsSync(p))
      // Fast stream copy: find the keyframe before each segment start and a clean end, then align cuts to them (see keyframe.ts).
      let copyCuts: Awaited<ReturnType<typeof lookupCopyCuts>> | undefined
      const silentSources = new Set<string>()
      if (resolveQuality(req.items, req, probes).quality === 'copy') {
        copyCuts = await lookupCopyCuts(req.items, deps.copyCut ?? createCutLookup(), ac.signal)
        if (ac.signal.aborted) return { ok: false, cancelled: true, outputs: [], notices: [] }
      } else if (req.mode === 'concat') {
        const hasAudio = deps.hasAudio ?? createAudioProbe()
        for (const source of probes.keys()) {
          if (await hasAudio(source, ac.signal) === false) silentSources.add(source)
          if (ac.signal.aborted) return { ok: false, cancelled: true, outputs: [], notices: [] }
        }
      }
      const naming = { ...req, outDir: req.outputDir, baseName: free.baseName, copyCuts, silentSources }
      const { jobs, notices, concatListContent: staticList } = buildJobs(req.items, naming, probes)
      // Concatenation: after all intermediate files are ready, measure each actual playback end for the list duration (keep the original duration if measurement fails).
      const segmentFiles = jobs.filter((j) => j.intermediate).map((j) => j.output)
      const measure = deps.mediaEnd ?? createMediaEndProbe()
      const concatListContent =
        staticList && segmentFiles.length > 0
          ? async (): Promise<string> => concatList(segmentFiles, await measureMediaEnds(segmentFiles, measure, ac.signal))
          : staticList
      if (free.renamed) notices.push(tr('輸出資料夾已有同名檔案，已改用「{baseName}」，不會覆蓋原有檔案', { baseName: free.baseName }))
      // Defense in depth: output files must be directly inside the actual output directory (outDir/<subdirectory>).
      for (const j of jobs) {
        if (path.dirname(path.resolve(j.output)) !== req.outputDir) throw new RequestError(tr('輸出路徑不正確'))
      }
      const totalDur = req.items.reduce((s, it) => s + Math.max(0, it.end - it.start), 0)

      const result = await runExport(
        {
          jobs,
          totalEstimatedSeconds: totalDur,
          outDir: req.outputDir,
          estimatedBytes: estimateOutputBytes({ items: req.items }, req.quality),
          concatListContent,
          ffmpeg: deps.ffmpeg,
          tempDir: deps.tempDir
        },
        {
          signal: ac.signal,
          onProgress: (progress) => {
            if (sender.isDestroyed()) return
            try {
              sender.send('export:progress', progress)
            } catch {
              // The window was destroyed while sending.
            }
          }
        }
      )
      return { ...result, notices }
    } catch (err) {
      return { ok: false, error: (err as Error).message, outputs: [] }
    } finally {
      sender.removeListener?.('destroyed', onDestroyed)
      current = null
      resolveDone()
    }
  }

  /** Cancel an active export; no-op when none is active or cancellation is already underway (returns cancelled:false). */
  function cancel(): { cancelled: boolean } {
    if (!current || current.ac.signal.aborted) return { cancelled: false }
    current.ac.abort()
    return { cancelled: true }
  }

  /** Cancel and wait until ffmpeg exits and partial files are removed (used on window close/app exit). */
  async function cancelAndWait(): Promise<void> {
    const c = current
    if (!c) return
    c.ac.abort()
    await c.done
  }

  /**
   * Check the output directory before starting (exists, is a directory, and is writable); share assertWritableDir with `export:start`
   * so invalid directories block on the settings page instead of failing after start. Return a result instead of throwing (so IPC does not prefix the error message).
   */
  async function checkOutDir(dir: unknown): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!isSafeLocalDirPath(dir)) return { ok: false, reason: tr('輸出資料夾路徑不正確') }
    try {
      await assertWritableDir(path.resolve(dir))
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: (err as Error).message }
    }
  }

  async function diskSpace(dir: unknown): Promise<{ freeBytes: number; totalBytes: number }> {
    if (!isSafeLocalDirPath(dir)) throw new Error(tr('磁碟路徑不正確'))
    const resolved = path.resolve(dir)
    const st = await fs.promises.stat(resolved).catch(() => null)
    if (!st || !st.isDirectory()) throw new Error(tr('資料夾不存在'))
    const s = await fs.promises.statfs(resolved)
    return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) }
  }

  return { start, cancel, cancelAndWait, diskSpace, checkOutDir, isRunning: () => current !== null }
}

export type ExportService = ReturnType<typeof createExportService>

export function registerExportHandlers(ipcMain: IpcMainLike, service: ExportService): void {
  ipcMain.handle('export:start', (event, opts: unknown) => service.start(event.sender, opts))
  ipcMain.handle('export:cancel', () => service.cancel())
  ipcMain.handle('export:diskSpace', (_event, dir: unknown) => service.diskSpace(dir))
  ipcMain.handle('export:checkOutDir', (_event, dir: unknown) => service.checkOutDir(dir))
}
