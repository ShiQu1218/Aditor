/**
 * 匯出相關 IPC 的處理本體（不依賴 electron，可用假 ipcMain／webContents 測試）。
 * 頻道：`export:start`、`export:cancel`、`export:diskSpace`、`export:checkOutDir`；進度經 `export:progress` 只送給發出請求的視窗。
 */
import fs from 'fs'
import path from 'path'
import { buildJobs, escapeConcatPath, resolveFreeBaseName, StreamProbe } from './plan'
import { runExport, RunExportOptions, RunProgress } from './run'
import { isSafeLocalDirPath, isSafeLocalVideoPath, fileExistsSafe } from '../safe-path'
import { estimateOutputBytes } from '../../shared/exportEstimate'

export interface ExportSender {
  isDestroyed(): boolean
  send(channel: string, data: RunProgress): void
  /** webContents 的 'destroyed' 事件（視窗關閉）；缺少時由呼叫端另行呼叫 cancel */
  once?(event: 'destroyed', listener: () => void): unknown
  removeListener?(event: 'destroyed', listener: () => void): unknown
}

export interface IpcMainLike {
  handle(channel: string, listener: (event: { sender: ExportSender }, ...args: any[]) => unknown): void
}

export interface ExportServiceDeps {
  /** 取得來源影片資訊（引擎 probe）；失敗或缺少時採預設值 */
  probe?: (source: string) => Promise<unknown>
  ffmpeg?: RunExportOptions['ffmpeg']
  tempDir?: string
}

export interface ValidatedRequest {
  items: Array<{ id: string; source: string; start: number; end: number }>
  mode: 'separate' | 'concat'
  quality: 'copy' | 'precise'
  encoder?: string
  outDir: string
  baseName: string
}

class RequestError extends Error {}

const MAX_ITEMS = 2000
const MAX_BASENAME = 100
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** 檔名主體清理：去掉路徑分隔與 Windows 非法字元、結尾點／空白、保留字，限制長度；空字串→`export`。 */
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
    throw new RequestError('輸出資料夾不存在')
  }
  if (!st.isDirectory()) throw new RequestError('輸出路徑不是資料夾')
  const probe = path.join(dir, `.apexhl-write-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`)
  try {
    await fs.promises.writeFile(probe, '', { flag: 'wx' })
  } catch {
    throw new RequestError('輸出資料夾無法寫入')
  }
  await fs.promises.rm(probe, { force: true }).catch(() => undefined)
}

export async function validateExportRequest(raw: unknown): Promise<ValidatedRequest> {
  if (typeof raw !== 'object' || raw === null) throw new RequestError('匯出請求格式不正確')
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.items) || r.items.length === 0) throw new RequestError('沒有可匯出的片段')
  if (r.items.length > MAX_ITEMS) throw new RequestError('片段數量過多')
  const items: ValidatedRequest['items'] = []
  for (const it of r.items) {
    if (typeof it !== 'object' || it === null) throw new RequestError('片段格式不正確')
    const { id, source, start, end } = it as Record<string, unknown>
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)) {
      throw new RequestError('片段時間必須是有限數字')
    }
    if (start < 0 || end <= start) throw new RequestError('片段時間範圍不正確')
    if (!isSafeLocalVideoPath(source)) throw new RequestError('來源影片路徑不正確')
    if (!(await fileExistsSafe(source))) throw new RequestError(`找不到來源影片：${source}`)
    items.push({ id: typeof id === 'string' ? id : '', source, start, end })
  }
  if (r.mode !== 'separate' && r.mode !== 'concat') throw new RequestError('匯出模式不正確')
  if (r.quality !== 'copy' && r.quality !== 'precise') throw new RequestError('匯出品質不正確')
  let encoder: string | undefined
  if (r.encoder !== undefined && r.encoder !== null) {
    if (typeof r.encoder !== 'string' || !/^[A-Za-z0-9_]{1,40}$/.test(r.encoder)) throw new RequestError('編碼器名稱不正確')
    encoder = r.encoder
  }
  if (!isSafeLocalDirPath(r.outDir)) throw new RequestError('輸出資料夾路徑不正確')
  const outDir = path.resolve(r.outDir)
  await assertWritableDir(outDir)
  if (typeof r.baseName !== 'string') throw new RequestError('檔名不正確')
  return { items, mode: r.mode, quality: r.quality, encoder, outDir, baseName: sanitizeBaseName(r.baseName) }
}

/** 取不到資訊時的預設：編碼／解析度採常見值，幀率、像素格式、音訊規格標為未知（0／空字串），相容性判斷會保守處理。 */
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
  /** 同一時間只允許一個匯出；在任何 await 之前就設定，避免同一 tick 的兩個 start 都通過檢查 */
  let current: { ac: AbortController; done: Promise<unknown> } | null = null

  async function start(sender: ExportSender, raw: unknown): Promise<ExportStartResult> {
    if (current) return { ok: false, code: 'busy', error: '已有匯出正在進行中，請等待完成或先取消', outputs: [] }
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
              // 引擎目前只提供 codec／解析度；有提供的其他欄位才採用，否則維持未知
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
            // 取不到資訊就用預設值
          }
        }
        probes.set(item.source, info)
      }
      if (ac.signal.aborted) return { ok: false, cancelled: true, outputs: [], notices: [] }

      // 不覆蓋既有檔案：同名就改成「<名稱> (2)」（I6）
      const free = resolveFreeBaseName(req.outDir, req.baseName, req.mode, req.items.length, (p) => fs.existsSync(p))
      const naming = { ...req, baseName: free.baseName }
      const { jobs, notices, concatListContent: normalizedList } = buildJobs(req.items, naming, probes)
      if (free.renamed) notices.push(`輸出資料夾已有同名檔案，已改用「${free.baseName}」，不會覆蓋原有檔案`)
      // 防禦：輸出檔必須直接位於 outDir 內
      for (const j of jobs) {
        if (path.dirname(path.resolve(j.output)) !== req.outDir) throw new RequestError('輸出路徑不正確')
      }
      const totalDur = req.items.reduce((s, it) => s + Math.max(0, it.end - it.start), 0)
      let concatListContent: string | undefined = normalizedList
      if (req.mode === 'concat' && !concatListContent) {
        const lines: string[] = []
        for (const it of req.items) {
          lines.push(`file ${escapeConcatPath(it.source)}`, `inpoint ${it.start.toFixed(3)}`, `outpoint ${it.end.toFixed(3)}`)
        }
        concatListContent = lines.join('\n') + '\n'
      }

      const result = await runExport(
        {
          jobs,
          totalEstimatedSeconds: totalDur,
          outDir: req.outDir,
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
              // 視窗在送出瞬間被銷毀
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

  /** 中止進行中的匯出；沒有進行中、或已經在中止中＝no-op（回傳 cancelled:false） */
  function cancel(): { cancelled: boolean } {
    if (!current || current.ac.signal.aborted) return { cancelled: false }
    current.ac.abort()
    return { cancelled: true }
  }

  /** 中止並等到 ffmpeg 已結束、partial 已清除（視窗關閉／App 結束時用） */
  async function cancelAndWait(): Promise<void> {
    const c = current
    if (!c) return
    c.ac.abort()
    await c.done
  }

  /**
   * 開始前檢查輸出資料夾（存在、是資料夾、可寫入）；與 `export:start` 共用同一個 assertWritableDir，
   * 讓壞資料夾在設定頁就成為阻擋條件，而不是按下開始後才出現失敗頁。回傳結果而非丟錯（錯誤訊息才不會被 IPC 加前綴）。
   */
  async function checkOutDir(dir: unknown): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!isSafeLocalDirPath(dir)) return { ok: false, reason: '輸出資料夾路徑不正確' }
    try {
      await assertWritableDir(path.resolve(dir))
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: (err as Error).message }
    }
  }

  async function diskSpace(dir: unknown): Promise<{ freeBytes: number; totalBytes: number }> {
    if (!isSafeLocalDirPath(dir)) throw new Error('磁碟路徑不正確')
    const resolved = path.resolve(dir)
    const st = await fs.promises.stat(resolved).catch(() => null)
    if (!st || !st.isDirectory()) throw new Error('資料夾不存在')
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
