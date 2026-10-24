import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { spawn, type ChildProcess } from 'child_process'
import { codecsDir, proxyDir } from '../shared/paths'
import { detectEncoders } from './export/encoders'
import { killTree } from './export/killTree'
import { normalizePath } from './library'
import { tr } from '../shared/locale'
import { sourceStamp, stampMediaCache } from './media-cache'

export function proxyPath(videoPath: string): string {
  const hash = crypto.createHash('sha1').update(normalizePath(videoPath)).digest('hex')
  return path.join(proxyDir(), `${hash}.mp4`)
}

export function buildProxyArgs(input: string, output: string, encoder: string): string[] {
  return [
    '-i',
    input,
    '-vf',
    'scale=-2:540',
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

const ENCODER_PRIORITY = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libopenh264']

/** List detected, available H.264 encoders in priority order (unavailable encoders are omitted). */
export function orderEncoders(available: string[]): string[] {
  return ENCODER_PRIORITY.filter((e) => available.includes(e))
}

/** First available encoder; return null when none are available (do not assume NVENC exists). */
export function pickEncoder(available: string[]): string | null {
  return orderEncoders(available)[0] ?? null
}

/** Convert ffmpeg stderr `time=HH:MM:SS.xx` and video duration to progress 0–1; return null when it cannot be parsed. */
export function parseFfmpegProgress(line: string, durationSec: number): number | null {
  if (!(durationSec > 0)) return null
  const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line)
  if (!m) return null
  const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  return Math.max(0, Math.min(1, sec / durationSec))
}

export interface ProxyDeps {
  /** Get the list of encoders verified to work; defaults to detectEncoders() (cached, not retested every time). */
  detect?: () => Promise<string[]>
  ffmpeg?: { bin: string; prefixArgs?: string[] }
}

let detectedCache: Promise<string[]> | null = null
async function defaultDetect(): Promise<string[]> {
  if (!detectedCache) {
    detectedCache = detectEncoders().then((r) => {
      // An empty list may reflect a temporary failure (for example, OpenH264 was just installed), so do not cache it.
      if (r.length === 0) detectedCache = null
      return r
    })
  }
  return detectedCache
}
/** Call after installing OpenH264 so the next proxy generation redetects encoders. */
export function resetProxyEncoderCache(): void {
  detectedCache = null
}

/** Put codecsDir() first in PATH so the libopenh264 fallback can find its DLL; Windows environment variable names are case-insensitive (Path). */
function envWithCodecsPath(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  env[key] = `${codecsDir()}${path.delimiter}${env[key] ?? ''}`
  return env
}

export function partialProxyPath(final: string): string {
  return final.replace(/.mp4$/i, '.partial.mp4')
}

/** Remove .partial.mp4 files left by an interrupted previous run at startup (completed proxies are unaffected). */
export function cleanStaleProxyPartials(): void {
  try {
    for (const f of fs.readdirSync(proxyDir())) {
      if (f.toLowerCase().endsWith('.partial.mp4')) fs.rmSync(path.join(proxyDir(), f), { force: true })
    }
  } catch {
    // Missing directory means no leftovers.
  }
}

const running = new Set<ChildProcess>()
let cancelling = false
const inflight = new Map<string, Promise<string>>()

/** Cancel all active proxy generations on app close: kill the ffmpeg tree and wait for partial files to be removed. */
export async function cancelAllProxies(): Promise<void> {
  cancelling = true
  try {
    await Promise.all([...running].map((p) => killTree(p)))
    await Promise.allSettled([...inflight.values()])
  } finally {
    cancelling = false
  }
}

function runFfmpeg(
  videoPath: string,
  partial: string,
  encoder: string,
  durationSec: number | undefined,
  onProgress: ((r: number) => void) | undefined,
  deps: ProxyDeps
): Promise<{ ok: true } | { ok: false; error: string }> {
  const args = buildProxyArgs(videoPath, partial, encoder)
  const bin = deps.ffmpeg?.bin ?? (process.env.ADITOR_FFMPEG || 'ffmpeg')
  return new Promise((resolve) => {
    const ffmpeg = spawn(bin, [...(deps.ffmpeg?.prefixArgs ?? []), ...args], {
      env: envWithCodecsPath(),
      windowsHide: true,
      detached: process.platform !== 'win32'
    })
    running.add(ffmpeg)
    let tail = ''
    ffmpeg.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      tail = (tail + text).slice(-2048)
      const r = parseFfmpegProgress(text, durationSec ?? 0)
      if (r !== null) onProgress?.(r)
    })
    ffmpeg.on('close', (code) => {
      running.delete(ffmpeg)
      resolve(code === 0 ? { ok: true } : { ok: false, error: `exit code ${code}: ${tail.trim().slice(-300)}` })
    })
    ffmpeg.on('error', (err) => {
      running.delete(ffmpeg)
      resolve({ ok: false, error: err.message })
    })
  })
}

async function removePartial(p: string): Promise<void> {
  for (let i = 0; i < 8; i++) {
    try {
      fs.rmSync(p, { force: true })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 100 * (i + 1)))
    }
  }
}

/**
 * Generate a 960x540 proxy using encoders verified to work (try them in priority order); write to .partial.mp4 first and rename to the final file only on success.
 * Remove partial files on failure or cancellation so `proxy:get` never sees a broken file.
 */
export function generateProxy(
  videoPath: string,
  onProgress?: (ratio: number) => void,
  durationSec?: number,
  deps: ProxyDeps = {}
): Promise<string> {
  const outPath = proxyPath(videoPath)
  const existing = inflight.get(outPath)
  if (existing) return existing
  const job = (async (): Promise<string> => {
    const stamp = sourceStamp(videoPath)
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    const candidates = orderEncoders(await (deps.detect ?? defaultDetect)())
    if (candidates.length === 0) {
      throw new Error(tr('找不到可用的 H.264 編碼器（未偵測到 NVENC／QSV／AMF，也尚未安裝 OpenH264）'))
    }
    const partial = partialProxyPath(outPath)
    const failures: string[] = []
    for (const encoder of candidates) {
      if (cancelling) throw new Error(tr('代理檔產生已取消'))
      const res = await runFfmpeg(videoPath, partial, encoder, durationSec, onProgress, deps)
      if (cancelling) {
        await removePartial(partial)
        throw new Error(tr('代理檔產生已取消'))
      }
      if (res.ok) {
        try {
          if (sourceStamp(videoPath) !== stamp) throw new Error(tr('來源影片已變更，請重新產生代理檔'))
          fs.renameSync(partial, outPath)
          stampMediaCache(outPath, stamp)
        } catch (err) {
          await removePartial(partial)
          throw new Error(tr('無法完成代理檔：{message}', { message: (err as Error).message }))
        }
        onProgress?.(1.0)
        return outPath
      }
      await removePartial(partial)
      failures.push(`${encoder}: ${res.error}`)
    }
    throw new Error(tr('代理檔產生失敗，已嘗試的編碼器皆無法使用（{failures}）', { failures: failures.join('；') }))
  })()
  inflight.set(outPath, job)
  const clear = (): void => {
    inflight.delete(outPath)
  }
  job.then(clear, clear)
  return job
}
