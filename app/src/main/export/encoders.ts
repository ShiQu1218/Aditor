import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { codecsDir } from '../../shared/paths'

export function parseEncoderList(stdout: string): string[] {
  const result: string[] = []
  const lines = stdout.split('\n')
  for (const line of lines) {
    // Look for video encoder lines: V..... <name> ...
    const match = line.match(/^\s*V\S*\s+([a-zA-Z0-9_-]+)/)
    if (match) {
      result.push(match[1])
    }
  }
  return result
}

export function pickEncoder(available: string[]): string | null {
  const priority = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libopenh264']
  for (const enc of priority) {
    if (available.includes(enc)) {
      return enc
    }
  }
  return null
}

function testEncoder(ffmpegBin: string, encoder: string, extraEnv?: Record<string, string>): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(
      ffmpegBin,
      ['-f', 'lavfi', '-i', 'color=c=black:s=16x16:d=0.1', '-c:v', encoder, '-f', 'null', '-'],
      {
        env: { ...process.env, ...extraEnv },
        stdio: 'ignore'
      }
    )
    proc.on('close', (code) => {
      resolve(code === 0)
    })
    proc.on('error', () => {
      resolve(false)
    })
  })
}

export async function detectEncoders(ffmpegBin = process.env.APEXHL_FFMPEG || 'ffmpeg'): Promise<string[]> {
  const candidates: string[] = await new Promise((resolve) => {
    const proc = spawn(ffmpegBin, ['-encoders'])
    let stdout = ''
    proc.stdout?.on('data', (d) => {
      stdout += d.toString()
    })
    proc.on('close', () => {
      resolve(parseEncoderList(stdout))
    })
    proc.on('error', () => {
      resolve([])
    })
  })

  const working: string[] = []
  const gpuEncoders = ['h264_nvenc', 'h264_qsv', 'h264_amf']

  for (const enc of gpuEncoders) {
    if (candidates.includes(enc)) {
      const ok = await testEncoder(ffmpegBin, enc)
      if (ok) {
        working.push(enc)
      }
    }
  }

  // Check libopenh264: either system or in codecsDir()
  if (candidates.includes('libopenh264')) {
    const dir = codecsDir()
    let hasDll = false
    try {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir)
        hasDll = files.some((f) => f.toLowerCase().endsWith('.dll') && f.toLowerCase().includes('openh264'))
      }
    } catch {}

    const extraEnv = hasDll ? { PATH: `${dir}${path.delimiter}${process.env.PATH || ''}` } : undefined
    const ok = await testEncoder(ffmpegBin, 'libopenh264', extraEnv)
    if (ok) {
      working.push('libopenh264')
    }
  }

  return working
}
