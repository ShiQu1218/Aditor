import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { spawn } from 'child_process'
import { proxyDir } from '../shared/paths'
import { normalizePath } from './library'

/** 縮圖上限 320x180（spec §6）：低階機的虛擬網格不必解碼原始解析度的 JPEG。 */
export const THUMB_MAX_W = 320
export const THUMB_MAX_H = 180

export function thumbnailPath(videoPath: string): string {
  const hash = crypto.createHash('sha1').update(normalizePath(videoPath)).digest('hex')
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

/** 先寫 `<hash>.tmp.jpg`，成功才 rename；失敗刪除半成品，之後不會被誤當成可用縮圖。 */
export async function generateThumbnail(videoPath: string, duration: number, deps: ThumbnailDeps = {}): Promise<string | undefined> {
  if (!fs.existsSync(videoPath)) return undefined
  const outPath = thumbnailPath(videoPath)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  if (fs.existsSync(outPath)) return outPath
  const tmp = outPath.replace(/\.jpg$/i, '.tmp.jpg')
  const t = Math.max(1, duration * 0.1)
  const bin = deps.ffmpeg?.bin ?? (process.env.APEXHL_FFMPEG || 'ffmpeg')
  const ok = await new Promise<boolean>((resolve) => {
    const proc = spawn(bin, [...(deps.ffmpeg?.prefixArgs ?? []), ...buildThumbnailArgs(videoPath, tmp, t)], { windowsHide: true })
    proc.on('close', (code) => resolve(code === 0 && fs.existsSync(tmp)))
    proc.on('error', () => resolve(false))
  })
  try {
    if (ok) {
      fs.renameSync(tmp, outPath)
      return outPath
    }
  } catch {
    // 落到下面的清理
  }
  fs.rmSync(tmp, { force: true })
  return undefined
}
