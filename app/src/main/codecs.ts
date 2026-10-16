import https from 'https'
import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import { spawn } from 'child_process'
import { Readable } from 'stream'
import { codecsDir, engineCommand } from '../shared/paths'

const OPENH264_HOST = 'ciscobinary.openh264.org'
const OPENH264_FILE = 'openh264-2.3.1-win64.dll.bz2'
const OPENH264_DLL = 'openh264-2.3.1-win64.dll'

/** 官方 2.3.1 win64 壓縮檔的大小與 SHA-256（2026-10-16 自官方網址下載計算並釘住；內容變動即拒絕）。 */
export const OPENH264_BZ2_SIZE = 448806
export const OPENH264_BZ2_SHA256 = '3d5bc8ce7a57f956f445f9aa98015d49c59623d89d78a9139ed8728ed853e197'

export function openh264Url(): string {
  return `https://${OPENH264_HOST}/${OPENH264_FILE}`
}

/** 只允許 https、主機完全等於 Cisco 官方網址、預設埠、無帳密、路徑為已知檔名。 */
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

/** 不跟隨轉址：官方網址直接回 200；任何轉址（可能轉到非白名單主機）一律視為失敗。 */
function httpsFetch(url: string): Promise<FetchedStream> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`下載 OpenH264 失敗: HTTP ${res.statusCode}`))
      }
      resolve({ stream: res, contentLength: parseInt(res.headers['content-length'] || '0', 10) })
    })
    req.setTimeout(30_000, () => req.destroy(new Error('下載 OpenH264 逾時')))
    req.on('error', reject)
  })
}

function pythonBz2(bz2Path: string, dllPath: string): Promise<void> {
  const cmd = engineCommand(false)
  return new Promise<void>((resolve, reject) => {
    const script = `import bz2, sys\nwith open(sys.argv[1], 'rb') as f_in, open(sys.argv[2], 'wb') as f_out:\n    f_out.write(bz2.decompress(f_in.read()))\n`
    const proc = spawn(cmd.command, ['-c', script, bz2Path, dllPath])
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`解壓縮 OpenH264 失敗 (exit code ${code})`))))
    proc.on('error', reject)
  })
}

export interface DownloadOptions {
  onProgress?: (ratio: number) => void
  /** 測試用覆寫 */
  url?: string
  dir?: string
  fetchStream?: (url: string) => Promise<FetchedStream>
  decompress?: (bz2Path: string, dllPath: string) => Promise<void>
  expected?: { size: number; sha256: string }
}

/** 下載官方 OpenH264：白名單網址 → 串流寫入暫存檔 → 驗證大小與 SHA-256 → 解壓縮；失敗一律清掉半成品。 */
export async function downloadOpenH264(opts: DownloadOptions = {}): Promise<string> {
  const url = opts.url ?? openh264Url()
  if (!isAllowedOpenH264Url(url)) throw new Error('OpenH264 下載網址不在允許清單內')
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
    if (contentLength > 0 && contentLength !== expected.size) throw new Error('OpenH264 檔案大小與預期不符')
    const hash = createHash('sha256')
    let downloaded = 0
    const ws = fs.createWriteStream(bz2Path)
    out = ws
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        downloaded += chunk.length
        if (downloaded > expected.size) {
          stream.destroy(new Error('OpenH264 檔案大小超過預期'))
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
    if (downloaded !== expected.size) throw new Error('OpenH264 檔案大小與預期不符')
    if (hash.digest('hex') !== expected.sha256) throw new Error('OpenH264 檔案雜湊校驗失敗，已拒絕使用')
    await (opts.decompress ?? pythonBz2)(bz2Path, dllTmp)
    fs.renameSync(dllTmp, dllPath)
    fs.rmSync(bz2Path, { force: true })
    opts.onProgress?.(1)
    return dllPath
  } catch (e) {
    cleanup()
    throw e
  }
}
