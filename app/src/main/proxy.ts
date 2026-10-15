import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { spawn } from 'child_process'
import { proxyDir } from '../shared/paths'
import { normalizePath } from './library'

export function proxyPath(videoPath: string): string {
  const hash = crypto.createHash('sha1').update(normalizePath(videoPath)).digest('hex')
  return path.join(proxyDir(), `${hash}.mp4`)
}

export function buildProxyArgs(input: string, output: string, encoder: string): string[] {
  return [
    '-i',
    input,
    '-vf',
    'scale=960:540',
    '-c:v',
    encoder,
    '-g',
    '30',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-y',
    output
  ]
}

export function pickEncoder(available: string[]): string {
  const order = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libopenh264']
  for (const enc of order) {
    if (available.includes(enc)) {
      return enc
    }
  }
  return available[0] || 'libopenh264'
}

/** 由 ffmpeg stderr 的 `time=HH:MM:SS.xx` 與影片長度換算進度 0–1；無法判讀回 null。 */
export function parseFfmpegProgress(line: string, durationSec: number): number | null {
  if (!(durationSec > 0)) return null
  const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line)
  if (!m) return null
  const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  return Math.max(0, Math.min(1, sec / durationSec))
}

export async function generateProxy(
  videoPath: string,
  onProgress?: (ratio: number) => void,
  durationSec?: number
): Promise<string> {
  const outPath = proxyPath(videoPath)
  const dir = path.dirname(outPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const encoder = pickEncoder(['h264_nvenc', 'h264_qsv', 'h264_amf', 'libopenh264'])
  const args = buildProxyArgs(videoPath, outPath, encoder)

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(process.env.APEXHL_FFMPEG || 'ffmpeg', args)
    ffmpeg.stderr?.on('data', (chunk: Buffer) => {
      const r = parseFfmpegProgress(chunk.toString(), durationSec ?? 0)
      if (r !== null) onProgress?.(r)
    })
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        onProgress?.(1.0)
        resolve(outPath)
      } else {
        reject(new Error(`ffmpeg proxy generation exited with code ${code}`))
      }
    })
    ffmpeg.on('error', reject)
  })
}
