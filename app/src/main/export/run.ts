import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { FfmpegJob } from './plan'
import { killTree } from './killTree'
import { appDataDir, codecsDir } from '../../shared/paths'
import { tr } from '../../shared/locale'

export interface RunProgress {
  jobIndex: number
  totalJobs: number
  percent: number
  outTimeSeconds: number
}

export interface RunExportOptions {
  jobs: FfmpegJob[]
  totalEstimatedSeconds: number
  outDir: string
  estimatedBytes: number
  /** concat 清單內容；給函式時在執行到用清單的 job 才呼叫（前面的中間檔都已完成，可量測實際長度） */
  concatListContent?: string | (() => Promise<string>)
  /** ffmpeg 可執行檔與前置參數；預設 `ADITOR_FFMPEG` 或 PATH 上的 `ffmpeg`。測試用假 ffmpeg 時 bin=node、prefixArgs=[腳本]。 */
  ffmpeg?: { bin: string; prefixArgs?: string[] }
  /** concat 清單暫存目錄，預設 `%APPDATA%\Aditor\temp` */
  tempDir?: string
}

export interface RunExportControl {
  signal?: AbortSignal
  onProgress?: (progress: RunProgress) => void
}

export type RunExportResult =
  | { ok: true; outputs: string[] }
  | { ok: false; cancelled: true; outputs: string[] }
  | { ok: false; cancelled?: false; error: string; outputs: string[] }

const STDERR_TAIL_BYTES = 4096

class InsufficientDiskSpaceError extends Error {}

export async function checkDiskSpace(outDir: string, estimatedBytes: number): Promise<void> {
  try {
    const stats = await fs.promises.statfs(outDir)
    const available = Number(stats.bavail) * Number(stats.bsize)
    const required = estimatedBytes * 1.1
    if (available < required) {
      throw new InsufficientDiskSpaceError(
        tr('磁碟剩餘空間不足（可用: {available} MB，需要約: {required} MB）', { available: (available / 1024 / 1024).toFixed(1), required: (required / 1024 / 1024).toFixed(1) })
      )
    }
  } catch (err) {
    if (err instanceof InsufficientDiskSpaceError) {
      throw err
    }
    // 檔案系統不支援 statfs 時略過檢查
    console.warn('Could not check disk space:', err)
  }
}

/** `<dir>/<name>.mp4` → `<dir>/<name>.partial.mp4`（保留 .mp4 副檔名，ffmpeg 才能由副檔名判斷容器格式） */
export function partialPathFor(output: string): string {
  const ext = path.extname(output)
  return path.join(path.dirname(output), path.basename(output, ext) + '.partial' + ext)
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** 刪檔；Windows 上剛被殺掉的程序可能還短暫鎖著檔案，EBUSY/EPERM 時重試。 */
async function removeFile(p: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await fs.promises.rm(p, { force: true })
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') return
      await sleep(100 * (attempt + 1))
    }
  }
}

class JobFailure extends Error {}

/** 目標已存在就改成 `<name> (2).mp4`、`<name> (3).mp4`…；不存在則原樣回傳。 */
export function freeOutputPath(target: string): string {
  if (!fs.existsSync(target)) return target
  const ext = path.extname(target)
  const stem = path.join(path.dirname(target), path.basename(target, ext))
  for (let n = 2; n < 10000; n++) {
    const candidate = `${stem} (${n})${ext}`
    if (!fs.existsSync(candidate)) return candidate
  }
  return `${stem} (${Date.now()})${ext}`
}

/**
 * 依序執行 ffmpeg jobs。每個輸出先寫到 `<name>.partial.mp4`，成功後 rename 成正式檔名。
 * 中止（signal）：殺掉 ffmpeg 及其子孫程序、刪除目前 job 的 partial 檔、保留已完成的輸出，
 * 回傳 `{ ok:false, cancelled:true, outputs }`。失敗（非 0 結束碼等）同樣刪除 partial 並回傳 stderr 最後 4 KB。
 */
export async function runExport(opts: RunExportOptions, control: RunExportControl = {}): Promise<RunExportResult> {
  const { signal, onProgress } = control
  const { jobs } = opts
  const completed: string[] = []
  const tempFilesToClean: string[] = []

  if (signal?.aborted) return { ok: false, cancelled: true, outputs: completed }

  try {
    // 合輯先寫每段中間檔、再寫成品，中間檔到最後才刪：尖峰約需兩倍空間
    const peakFactor = jobs.some((j) => j.intermediate) ? 2 : 1
    await checkDiskSpace(opts.outDir, opts.estimatedBytes * peakFactor)
  } catch (err) {
    return { ok: false, error: (err as Error).message, outputs: completed }
  }
  if (signal?.aborted) return { ok: false, cancelled: true, outputs: completed }

  const ffmpegBin = opts.ffmpeg?.bin ?? (process.env.ADITOR_FFMPEG || 'ffmpeg')
  const prefixArgs = opts.ffmpeg?.prefixArgs ?? []
  const extraEnv: Record<string, string> = {}
  const cDir = codecsDir()
  if (fs.existsSync(cDir)) {
    extraEnv.PATH = `${cDir}${path.delimiter}${process.env.PATH || ''}`
  }

  try {
    for (let i = 0; i < jobs.length; i++) {
      if (signal?.aborted) return { ok: false, cancelled: true, outputs: completed }
      const job = jobs[i]
      const partial = partialPathFor(job.output)
      if (job.intermediate) tempFilesToClean.push(job.output)
      // 輸出參數（最後一個 `-y <output>`）改寫到 partial 路徑
      let args = job.args.map((a) => (a === job.output ? partial : a))

      if (args.includes('LIST_FILE_PLACEHOLDER') && opts.concatListContent) {
        const tempDir = opts.tempDir ?? path.join(appDataDir(), 'temp')
        fs.mkdirSync(tempDir, { recursive: true })
        const tempFile = path.join(tempDir, `concat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.txt`)
        const listContent = typeof opts.concatListContent === 'function' ? await opts.concatListContent() : opts.concatListContent
        if (signal?.aborted) return { ok: false, cancelled: true, outputs: completed }
        fs.writeFileSync(tempFile, listContent, 'utf-8')
        tempFilesToClean.push(tempFile)
        args = args.map((a) => (a === 'LIST_FILE_PLACEHOLDER' ? tempFile : a))
      }

      const outcome = await new Promise<'ok' | 'cancelled'>((resolve, reject) => {
        const proc = spawn(ffmpegBin, [...prefixArgs, '-progress', 'pipe:1', ...args], {
          env: { ...process.env, ...extraEnv },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          // 非 Windows：自成程序群組，killTree 才能用 process.kill(-pid) 一次殺掉整棵樹
          detached: process.platform !== 'win32'
        })

        let stderrBuffer = ''
        let stdoutRest = ''
        let spawnError: Error | null = null

        const onAbort = (): void => {
          void killTree(proc)
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        // 監聽器掛上前就已中止的競態
        if (signal?.aborted) onAbort()
        const cleanup = (): void => signal?.removeEventListener('abort', onAbort)

        proc.stdout?.on('data', (data) => {
          const lines = (stdoutRest + data.toString()).split('\n')
          stdoutRest = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.startsWith('out_time_us=')) continue
            const us = parseInt(line.split('=')[1], 10)
            if (isNaN(us)) continue
            const outSec = us / 1000000
            const percent = Math.min(
              100,
              Math.round(((i + outSec / Math.max(1, opts.totalEstimatedSeconds)) / jobs.length) * 100)
            )
            try {
              onProgress?.({ jobIndex: i, totalJobs: jobs.length, percent, outTimeSeconds: outSec })
            } catch {
              // 進度回呼出錯不能影響匯出
            }
          }
        })

        proc.stderr?.on('data', (data) => {
          stderrBuffer += data.toString()
          if (stderrBuffer.length > STDERR_TAIL_BYTES * 2) {
            stderrBuffer = stderrBuffer.slice(-STDERR_TAIL_BYTES)
          }
        })

        proc.on('error', (err) => {
          spawnError = err
          // 根本沒啟動（ENOENT 等）不保證會有 close 事件，直接結束這個 job（Promise 重複 settle 無害）
          if (proc.pid === undefined) {
            cleanup()
            reject(new JobFailure(tr('無法啟動 ffmpeg：{message}', { message: err.message })))
          }
        })

        proc.on('close', (code) => {
          cleanup()
          if (signal?.aborted) {
            resolve('cancelled')
          } else if (spawnError) {
            reject(new JobFailure(tr('無法啟動 ffmpeg：{message}', { message: spawnError.message })))
          } else if (code === 0) {
            resolve('ok')
          } else {
            reject(new JobFailure(tr('匯出失敗 (exit code {code}):\n{stderr}', { code, stderr: stderrBuffer.slice(-STDERR_TAIL_BYTES) })))
          }
        })
      }).catch(async (err: Error) => {
        await removeFile(partial)
        throw err
      })

      if (outcome === 'cancelled') {
        await removeFile(partial)
        return { ok: false, cancelled: true, outputs: completed }
      }

      // 中間檔留在原處，最後一併刪除；成品若遇到同名檔案（匯出期間才出現的）絕不覆蓋，改用「 (2)」之類的名稱（I6）
      const finalPath = job.intermediate ? job.output : freeOutputPath(job.output)
      try {
        await fs.promises.rename(partial, finalPath)
      } catch (err) {
        await removeFile(partial)
        throw new JobFailure(tr('無法完成輸出檔：{message}', { message: (err as Error).message }))
      }
      if (!job.intermediate) completed.push(finalPath)
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message, outputs: completed }
  } finally {
    for (const f of tempFilesToClean) {
      try {
        fs.rmSync(f, { force: true })
      } catch {}
    }
  }

  return { ok: true, outputs: completed }
}
