import https from 'https'
import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import { spawn } from 'child_process'
import { Readable } from 'stream'
import { codecsDir } from '../shared/paths'
import { decompressBz2File } from './bz2'
import { tr } from '../shared/locale'

const OPENH264_HOST = 'ciscobinary.openh264.org'
const OPENH264_FILE = 'openh264-2.3.1-win64.dll.bz2'
const OPENH264_DLL = 'openh264-2.3.1-win64.dll'

/** Pinned size and SHA-256 for the official 2.3.1 win64 archive (downloaded from the official URL and verified on 2026-10-16; reject any content change). */
export const OPENH264_BZ2_SIZE = 448806
export const OPENH264_BZ2_SHA256 = '3d5bc8ce7a57f956f445f9aa98015d49c59623d89d78a9139ed8728ed853e197'

export function openh264Url(): string {
  return `https://${OPENH264_HOST}/${OPENH264_FILE}`
}

/** Allow only https, the exact official Cisco host, the default port, no credentials, and a known filename path. */
export function isAllowedOpenH264Url(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  return (
    u.protocol === 'https:' &&
    u.hostname === OPENH264_HOST &&
    u.port === '' &&
    u.username === '' &&
    u.password === '' &&
    u.pathname === `/${OPENH264_FILE}` &&
    u.search === '' &&
    u.hash === ''
  )
}

export function hasOpenH264(): boolean {
  const dir = codecsDir()
  if (!fs.existsSync(dir)) return false
  const files = fs.readdirSync(dir)
  return files.some((f) => f.toLowerCase().endsWith('.dll') && f.toLowerCase().includes('openh264'))
}

export interface FetchedStream {
  stream: Readable
  contentLength: number
}

/** Do not follow redirects: the official URL returns 200 directly; reject every redirect (which could point to a non-allowlisted host). */
function httpsFetch(url: string): Promise<FetchedStream> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(tr('下載 OpenH264 失敗: HTTP {statusCode}', { statusCode: res.statusCode })))
      }
      resolve({ stream: res, contentLength: parseInt(res.headers['content-length'] || '0', 10) })
    })
    req.setTimeout(30_000, () => req.destroy(new Error(tr('下載 OpenH264 逾時'))))
    req.on('error', reject)
  })
}

export interface DownloadOptions {
  onProgress?: (ratio: number) => void
  /** Test override. */
  url?: string
  dir?: string
  fetchStream?: (url: string) => Promise<FetchedStream>
  decompress?: (bz2Path: string, dllPath: string) => Promise<void>
  expected?: { size: number; sha256: string }
}

/** Download official OpenH264: allowlisted URL → stream to a temporary file → verify size and SHA-256 → decompress; remove partial files on failure. */
export async function downloadOpenH264(opts: DownloadOptions = {}): Promise<string> {
  const url = opts.url ?? openh264Url()
  if (!isAllowedOpenH264Url(url)) throw new Error(tr('OpenH264 下載網址不在允許清單內'))
  const dir = opts.dir ?? codecsDir()
  const expected = opts.expected ?? { size: OPENH264_BZ2_SIZE, sha256: OPENH264_BZ2_SHA256 }
  fs.mkdirSync(dir, { recursive: true })
  const bz2Path = path.join(dir, OPENH264_FILE + '.part')
  const dllPath = path.join(dir, OPENH264_DLL)
  const dllTmp = dllPath + '.part'
  let out: fs.WriteStream | null = null
  const cleanup = (): void => {
    out?.destroy()
    for (const f of [bz2Path, dllTmp]) fs.rmSync(f, { force: true })
  }
  try {
    const { stream, contentLength } = await (opts.fetchStream ?? httpsFetch)(url)
    if (contentLength > 0 && contentLength !== expected.size) throw new Error(tr('OpenH264 檔案大小與預期不符'))
    const hash = createHash('sha256')
    let downloaded = 0
    const ws = fs.createWriteStream(bz2Path)
    out = ws
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        downloaded += chunk.length
        if (downloaded > expected.size) {
          stream.destroy(new Error(tr('OpenH264 檔案大小超過預期')))
          return
        }
        hash.update(chunk)
        opts.onProgress?.(Math.min(1, downloaded / expected.size))
      })
      stream.on('error', reject)
      ws.on('error', reject)
      ws.on('finish', () => resolve())
      stream.pipe(ws)
    })
    if (downloaded !== expected.size) throw new Error(tr('OpenH264 檔案大小與預期不符'))
    if (hash.digest('hex') !== expected.sha256) throw new Error(tr('OpenH264 檔案雜湊校驗失敗，已拒絕使用'))
    await (opts.decompress ?? decompressBz2File)(bz2Path, dllTmp)
    fs.renameSync(dllTmp, dllPath)
    fs.rmSync(bz2Path, { force: true })
    opts.onProgress?.(1)
    return dllPath
  } catch (e) {
    cleanup()
    throw e
  }
}
