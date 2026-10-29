import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
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
  /** Concat list contents; when a function is provided, call it only when the list-using job runs (preceding intermediate files are ready and can be measured). */
  concatListContent?: string | (() => Promise<string>)
  /** ffmpeg executable and prefix arguments; defaults to `ADITOR_FFMPEG` or `ffmpeg` on PATH. For fake ffmpeg tests, use bin=node and prefixArgs=[script]. */
  ffmpeg?: { bin: string; prefixArgs?: string[] }
  /** Temporary directory for concat lists; defaults to `%APPDATA%\Aditor\temp`. */
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
    // Skip the check when the filesystem does not support statfs.
    console.warn('Could not check disk space:', err)
  }
}

/** Convert `<dir>/<name>.mp4` to `<dir>/<name>.partial.mp4` (keep the .mp4 extension so ffmpeg can infer the container format). */
export function partialPathFor(output: string): string {
  const ext = path.extname(output)
  return path.join(path.dirname(output), path.basename(output, ext) + '.partial' + ext)
}

function reservePartial(output: string): string {
  let partial = partialPathFor(output)
  for (;;) {
    try {
      fs.closeSync(fs.openSync(partial, 'wx'))
      return partial
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const ext = path.extname(output)
      partial = partialPathFor(output.slice(0, -ext.length) + `.${randomUUID()}` + ext)
    }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Delete a file; on Windows, a recently killed process may hold a temporary lock, so retry on EBUSY/EPERM. */
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

/** Publish without replacing a file created by another process, including between name selection and publication. */
async function publishOutput(partial: string, target: string, intermediate: boolean): Promise<string> {
  const ext = path.extname(target)
  const stem = path.join(path.dirname(target), path.basename(target, ext))
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? target : `${stem} (${n})${ext}`
    try {
      try {
        await fs.promises.link(partial, candidate)
      } catch (err) {
        // FAT/exFAT and some network filesystems do not support hard links.
        if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err
        await fs.promises.copyFile(partial, candidate, fs.constants.COPYFILE_EXCL)
      }
      return candidate
    } catch (err) {
      if (intermediate || (err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
}

/**
 * Run ffmpeg jobs in order. Write each output to `<name>.partial.mp4` first, then publish it without overwriting existing files.
 * On cancellation (signal), kill ffmpeg and its descendants, remove the current job's partial file, keep completed outputs,
 * and return `{ ok:false, cancelled:true, outputs }`. On failure (non-zero exit code, etc.), also remove the partial and return the last 4 KB of stderr.
 */
export async function runExport(opts: RunExportOptions, control: RunExportControl = {}): Promise<RunExportResult> {
  const { signal, onProgress } = control
  const { jobs } = opts
  const completed: string[] = []
  const tempFilesToClean: string[] = []

  if (signal?.aborted) return { ok: false, cancelled: true, outputs: completed }

  try {
    // Concatenation writes intermediate segments before the final output and deletes them only at the end, requiring about twice the space at peak.
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

  // Progress is weighted by each job's output length; jobs without one share the estimate evenly.
  const jobSeconds = jobs.map((j) => j.durationSec ?? opts.totalEstimatedSeconds / jobs.length)
  const totalJobSeconds = jobSeconds.reduce((s, d) => s + d, 0)
  let doneSeconds = 0

  try {
    for (let i = 0; i < jobs.length; i++) {
      if (signal?.aborted) return { ok: false, cancelled: true, outputs: completed }
      const job = jobs[i]
      if (job.args.at(-1) !== job.output) throw new JobFailure('Invalid export output argument')
      if (job.intermediate && fs.existsSync(job.output)) throw new JobFailure('Intermediate output already exists')
      const partial = reservePartial(job.output)
      tempFilesToClean.push(partial)
      // Rewrite the output argument (the final `-y <output>`) to the partial path.
      let args = [...job.args.slice(0, -1), partial]

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
          // On non-Windows, create a process group so killTree can terminate the entire tree with process.kill(-pid).
          detached: process.platform !== 'win32'
        })

        let stderrBuffer = ''
        let stdoutRest = ''
        let spawnError: Error | null = null

        const onAbort = (): void => {
          void killTree(proc)
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        // Handle cancellation that happened before the listener was attached.
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
            const percent = totalJobSeconds > 0
              ? Math.min(100, Math.round(((doneSeconds + Math.min(outSec, jobSeconds[i])) / totalJobSeconds) * 100))
              : 0
            try {
              onProgress?.({ jobIndex: i, totalJobs: jobs.length, percent, outTimeSeconds: outSec })
            } catch {
              // A progress callback error must not affect the export.
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
          // A process that never started (ENOENT, etc.) may not emit close; finish this job directly (settling the Promise twice is harmless).
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

      // Keep intermediate files until final cleanup; never overwrite a final file that appeared during export, and use a name such as " (2)" instead (I6).
      let finalPath: string
      try {
        finalPath = await publishOutput(partial, job.output, !!job.intermediate)
        await removeFile(partial)
      } catch (err) {
        await removeFile(partial)
        throw new JobFailure(tr('無法完成輸出檔：{message}', { message: (err as Error).message }))
      }
      if (!job.intermediate) completed.push(finalPath)
      else tempFilesToClean.push(finalPath)
      doneSeconds += jobSeconds[i]
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
