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

export async function generateProxy(
  videoPath: string,
  onProgress?: (ratio: number) => void
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
