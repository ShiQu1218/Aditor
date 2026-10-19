import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { codecsDir } from '../../shared/paths'
import { killTree } from './killTree'

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

/** NVENC／AMF／QSV 都有最小畫面尺寸限制（NVENC 約 145x49 以上），測試畫面用 256x256 才不會誤判硬體不可用。 */
export function encoderTestArgs(encoder: string): string[] {
  return ['-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.1', '-c:v', encoder, '-f', 'null', '-']
}

const ENCODER_TEST_TIMEOUT_MS = 10_000

/** 實際編一小段測試畫面；驅動卡住時逾時（預設 10 秒）就視為不可用並終止程序。 */
export function testEncoder(
  ffmpegBin: string,
  encoder: string,
  extraEnv?: Record<string, string>,
  opts: { timeoutMs?: number; prefixArgs?: string[]; args?: string[] } = {}
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }
    const proc = spawn(ffmpegBin, [...(opts.prefixArgs ?? []), ...(opts.args ?? encoderTestArgs(encoder))], {
      env: { ...process.env, ...extraEnv },
      stdio: 'ignore',
      windowsHide: true
    })
    const timer = setTimeout(() => {
      void killTree(proc).then(() => finish(false))
    }, opts.timeoutMs ?? ENCODER_TEST_TIMEOUT_MS)
    proc.on('close', (code) => finish(code === 0))
    proc.on('error', () => finish(false))
  })
}

export async function detectEncoders(ffmpegBin = process.env.ADITOR_FFMPEG || 'ffmpeg'): Promise<string[]> {
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
