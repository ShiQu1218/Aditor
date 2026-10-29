import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { spawn, type ChildProcess } from 'child_process'
import { proxyDir } from '../shared/paths'
import { normalizePath } from './library'
import { sourceStamp } from './media-cache'
import { killTree } from './export/killTree'

/** Thumbnail limit 320x180 (spec §6): virtualized grids do not need to decode full-resolution JPEGs on low-end machines. */
export const THUMB_MAX_W = 320
export const THUMB_MAX_H = 180

export function thumbnailPath(videoPath: string): string {
  const hash = crypto.createHash('sha1').update(JSON.stringify([normalizePath(videoPath), sourceStamp(videoPath)])).digest('hex')
  return path.join(proxyDir(), 'thumbs', `${hash}.jpg`)
}

export function buildThumbnailArgs(videoPath: string, output: string, atSec: number): string[] {
  return [
    '-v',
    'error',
    '-ss',
    atSec.toFixed(2),
    '-i',
    videoPath,
    '-vframes',
    '1',
    '-vf',
    `scale=${THUMB_MAX_W}:${THUMB_MAX_H}:force_original_aspect_ratio=decrease`,
    '-q:v',
    '3',
    '-y',
    output
  ]
}

export interface ThumbnailDeps {
  ffmpeg?: { bin: string; prefixArgs?: string[] }
}

/** Recording finalization and the analysis queue can ask for the same thumbnail at once; they share one ffmpeg run and tmp file. */
const inflight = new Map<string, Promise<string | undefined>>()
const running = new Set<ChildProcess>()
let cancelling = false

/** Stop thumbnail encoders after recording finalization, and wait for their temporary files to be removed. */
export async function cancelAllThumbnails(): Promise<void> {
  cancelling = true
  try {
    await Promise.all([...running].map((proc) => killTree(proc)))
    await Promise.allSettled([...inflight.values()])
  } finally {
    cancelling = false
  }
}

export function generateThumbnail(videoPath: string, duration: number, deps: ThumbnailDeps = {}): Promise<string | undefined> {
  if (cancelling) return Promise.resolve(undefined)
  const key = thumbnailPath(videoPath)
  const existing = inflight.get(key)
  if (existing) return existing
  const job = renderThumbnail(videoPath, duration, deps).finally(() => inflight.delete(key))
  inflight.set(key, job)
  return job
}

/** Write `<hash>.tmp.jpg` first and rename only on success; remove partial files on failure so they are not mistaken for usable thumbnails. */
async function renderThumbnail(videoPath: string, duration: number, deps: ThumbnailDeps): Promise<string | undefined> {
  if (!fs.existsSync(videoPath)) return undefined
  const stamp = sourceStamp(videoPath)
  const outPath = thumbnailPath(videoPath)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  if (fs.existsSync(outPath)) return outPath
  const tmp = outPath.replace(/\.jpg$/i, '.tmp.jpg')
  const t = Math.max(0, duration * 0.1)
  const bin = deps.ffmpeg?.bin ?? (process.env.ADITOR_FFMPEG || 'ffmpeg')
  const ok = await new Promise<boolean>((resolve) => {
    const proc = spawn(bin, [...(deps.ffmpeg?.prefixArgs ?? []), ...buildThumbnailArgs(videoPath, tmp, t)], {
      windowsHide: true,
      detached: process.platform !== 'win32'
    })
    running.add(proc)
    proc.on('close', (code) => {
      running.delete(proc)
      resolve(code === 0 && fs.existsSync(tmp))
    })
    proc.on('error', () => {
      running.delete(proc)
      resolve(false)
    })
  })
  try {
    if (ok && !cancelling && sourceStamp(videoPath) === stamp) {
      fs.renameSync(tmp, outPath)
      return outPath
    }
  } catch {
    // Fall through to cleanup below.
  }
  fs.rmSync(tmp, { force: true })
  return undefined
}
