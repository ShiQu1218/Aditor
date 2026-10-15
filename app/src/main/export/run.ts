import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawn } from 'child_process'
import { FfmpegJob } from './plan'
import { appDataDir, codecsDir } from '../../shared/paths'

export interface RunProgress {
  jobIndex: number
  totalJobs: number
  percent: number
  outTimeSeconds: number
}

export async function checkDiskSpace(outDir: string, estimatedBytes: number): Promise<void> {
  try {
    const stats = await fs.promises.statfs(outDir)
    const available = Number(stats.bavail) * Number(stats.bsize)
    const required = estimatedBytes * 1.1
    if (available < required) {
      throw new Error(
        `磁碟剩餘空間不足（可用: ${(available / 1024 / 1024).toFixed(1)} MB，需要約: ${(required / 1024 / 1024).toFixed(1)} MB）`
      )
    }
  } catch (err) {
    if ((err as Error).message.includes('磁碟剩餘空間不足')) {
      throw err
    }
    // If statfs fails on unsupported filesystem, log and continue
    console.warn('Could not check disk space:', err)
  }
}

export async function executeExportJobs(
  jobs: FfmpegJob[],
  totalEstimatedSeconds: number,
  outDir: string,
  estimatedBytes: number,
  concatListContent?: string,
  onProgress?: (progress: RunProgress) => void
): Promise<string[]> {
  await checkDiskSpace(outDir, estimatedBytes)

  const createdOutputs: string[] = []
  const tempFilesToClean: string[] = []

  const ffmpegBin = process.env.APEXHL_FFMPEG || 'ffmpeg'
  const extraEnv: Record<string, string> = {}
  const cDir = codecsDir()
  if (fs.existsSync(cDir)) {
    extraEnv.PATH = `${cDir}${path.delimiter}${process.env.PATH || ''}`
  }

  try {
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i]
      let args = [...job.args]

      // Handle concat list file placeholder
      if (args.includes('LIST_FILE_PLACEHOLDER') && concatListContent) {
        const tempDir = path.join(appDataDir(), 'temp')
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true })
        }
        const tempFile = path.join(tempDir, `concat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.txt`)
        fs.writeFileSync(tempFile, concatListContent, 'utf-8')
        tempFilesToClean.push(tempFile)
        args = args.map((a) => (a === 'LIST_FILE_PLACEHOLDER' ? tempFile : a))
      }

      await new Promise<void>((resolve, reject) => {
        const fullArgs = ['-progress', 'pipe:1', ...args]
        const proc = spawn(ffmpegBin, fullArgs, {
          env: { ...process.env, ...extraEnv }
        })

        let stderrBuffer = ''

        proc.stdout?.on('data', (data) => {
          const text = data.toString()
          const lines = text.split('\n')
          for (const line of lines) {
            if (line.startsWith('out_time_us=')) {
              const us = parseInt(line.split('=')[1], 10)
              if (!isNaN(us)) {
                const outSec = us / 1000000
                const percent = Math.min(100, Math.round(((i + outSec / Math.max(1, totalEstimatedSeconds)) / jobs.length) * 100))
                onProgress?.({
                  jobIndex: i,
                  totalJobs: jobs.length,
                  percent,
                  outTimeSeconds: outSec
                })
              }
            }
          }
        })

        proc.stderr?.on('data', (data) => {
          stderrBuffer += data.toString()
          if (stderrBuffer.length > 8192) {
            stderrBuffer = stderrBuffer.slice(-4096)
          }
        })

        proc.on('close', (code) => {
          if (code === 0) {
            createdOutputs.push(job.output)
            resolve()
          } else {
            const last4kb = stderrBuffer.slice(-4096)
            reject(new Error(`匯出失敗 (exit code ${code}):\n${last4kb}`))
          }
        })

        proc.on('error', (err) => {
          reject(err)
        })
      })
    }
  } finally {
    // Cleanup temporary files
    for (const f of tempFilesToClean) {
      try {
        if (fs.existsSync(f)) {
          fs.unlinkSync(f)
        }
      } catch {}
    }
  }

  return createdOutputs
}
