import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { spawn, type ChildProcess } from 'child_process'
import { codecsDir, proxyDir } from '../shared/paths'
import { detectEncoders } from './export/encoders'
import { killTree } from './export/killTree'
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

/** 依優先順序列出「偵測到可用」的 H.264 編碼器（不可用的不會出現）。 */
export function orderEncoders(available: string[]): string[] {
  return ENCODER_PRIORITY.filter((e) => available.includes(e))
}

/** 第一個可用的編碼器；沒有則回 null（不再假設 NVENC 存在）。 */
export function pickEncoder(available: string[]): string | null {
  return orderEncoders(available)[0] ?? null
}

/** 由 ffmpeg stderr 的 `time=HH:MM:SS.xx` 與影片長度換算進度 0–1；無法判讀回 null。 */
export function parseFfmpegProgress(line: string, durationSec: number): number | null {
  if (!(durationSec > 0)) return null
  const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line)
  if (!m) return null
  const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  return Math.max(0, Math.min(1, sec / durationSec))
}

export interface ProxyDeps {
  /** 取得實測可用的編碼器清單；預設為 detectEncoders()（結果快取，不會每次重測）。 */
  detect?: () => Promise<string[]>
  ffmpeg?: { bin: string; prefixArgs?: string[] }
}

let detectedCache: Promise<string[]> | null = null
async function defaultDetect(): Promise<string[]> {
  if (!detectedCache) {
    detectedCache = detectEncoders().then((r) => {
      // 空清單可能只是暫時失敗（例如剛安裝 OpenH264），不快取
      if (r.length === 0) detectedCache = null
      return r
    })
  }
  return detectedCache
}
/** 安裝 OpenH264 後呼叫，讓下次產生代理檔重新偵測。 */
export function resetProxyEncoderCache(): void {
  detectedCache = null
}

/** 把 codecsDir() 放到 PATH 最前面（libopenh264 備援才找得到 DLL）；Windows 的環境變數名稱大小寫不分（Path）。 */
function envWithCodecsPath(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  env[key] = `${codecsDir()}${path.delimiter}${env[key] ?? ''}`
  return env
}

export function partialProxyPath(final: string): string {
  return final.replace(/.mp4$/i, '.partial.mp4')
}

/** 啟動時清掉上次中斷遺留的 .partial.mp4（已完成的代理檔不受影響）。 */
export function cleanStaleProxyPartials(): void {
  try {
    for (const f of fs.readdirSync(proxyDir())) {
      if (f.toLowerCase().endsWith('.partial.mp4')) fs.rmSync(path.join(proxyDir(), f), { force: true })
    }
  } catch {
    // 資料夾不存在＝沒有遺留
  }
}

const running = new Set<ChildProcess>()
let cancelling = false
const inflight = new Map<string, Promise<string>>()

/** 取消所有進行中的代理檔產生（App 關閉時）：殺掉 ffmpeg 樹，等 partial 清掉。 */
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
  const bin = deps.ffmpeg?.bin ?? (process.env.APEXHL_FFMPEG || 'ffmpeg')
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
 * 產生 960x540 代理檔：用實測可用的編碼器（依優先順序逐一嘗試）、先寫 .partial.mp4，成功才 rename 成正式檔。
 * 失敗或取消都會刪掉 partial，`proxy:get` 因此不會看到壞檔。
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
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    const candidates = orderEncoders(await (deps.detect ?? defaultDetect)())
    if (candidates.length === 0) {
      throw new Error('找不到可用的 H.264 編碼器（未偵測到 NVENC／QSV／AMF，也尚未安裝 OpenH264）')
    }
    const partial = partialProxyPath(outPath)
    const failures: string[] = []
    for (const encoder of candidates) {
      if (cancelling) throw new Error('代理檔產生已取消')
      const res = await runFfmpeg(videoPath, partial, encoder, durationSec, onProgress, deps)
      if (cancelling) {
        await removePartial(partial)
        throw new Error('代理檔產生已取消')
      }
      if (res.ok) {
        try {
          fs.renameSync(partial, outPath)
        } catch (err) {
          await removePartial(partial)
          throw new Error(`無法完成代理檔：${(err as Error).message}`)
        }
        onProgress?.(1.0)
        return outPath
      }
      await removePartial(partial)
      failures.push(`${encoder}: ${res.error}`)
    }
    throw new Error(`代理檔產生失敗，已嘗試的編碼器皆無法使用（${failures.join('；')}）`)
  })()
  inflight.set(outPath, job)
  const clear = (): void => {
    inflight.delete(outPath)
  }
  job.then(clear, clear)
  return job
}
