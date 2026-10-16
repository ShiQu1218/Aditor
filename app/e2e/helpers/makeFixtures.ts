import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

export interface FixtureSet {
  ok: boolean
  /** ok=false 時的略過原因 */
  reason: string
  dir: string
  ffmpeg: string | null
  videos: Array<{ path: string; title: string; seconds: number }>
}

/** 依 APEXHL_FFMPEG、再依 PATH 尋找 ffmpeg；找不到回 null。 */
export function findFfmpeg(): string | null {
  const candidates: string[] = []
  if (process.env.APEXHL_FFMPEG) candidates.push(process.env.APEXHL_FFMPEG)
  candidates.push('ffmpeg')
  for (const c of candidates) {
    const r = spawnSync(c, ['-version'], { windowsHide: true })
    if (r.status === 0) {
      if (path.isAbsolute(c)) return c
      const w = spawnSync(process.platform === 'win32' ? 'where' : 'which', [c], { encoding: 'utf-8', windowsHide: true })
      const first = w.stdout?.split(/\r?\n/).find((l) => l.trim())
      return first ? first.trim() : c
    }
  }
  return null
}

const SPECS = [
  { title: 'E2E clip A', seconds: 20 },
  { title: 'E2E clip B', seconds: 16 },
  { title: 'E2E clip C', seconds: 12 }
]

/** 以 testsrc2（H.264＋靜音 AAC）產生 3 支 10–20 秒的合成影片；不使用任何使用者影片。 */
export function makeFixtures(): FixtureSet {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apexhl-e2e-fixtures-'))
  const ffmpeg = findFfmpeg()
  if (!ffmpeg) return { ok: false, reason: '找不到 ffmpeg（PATH 或 APEXHL_FFMPEG）：需要影片的 E2E 案例略過', dir, ffmpeg: null, videos: [] }
  const videos: FixtureSet['videos'] = []
  for (const s of SPECS) {
    const out = path.join(dir, `${s.title}.mp4`)
    const r = spawnSync(
      ffmpeg,
      [
        '-v', 'error', '-y',
        '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=30:duration=${s.seconds}`,
        '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo`,
        '-t', String(s.seconds),
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-g', '30',
        '-c:a', 'aac', '-shortest', out
      ],
      { encoding: 'utf-8', windowsHide: true }
    )
    if (r.status !== 0 || !fs.existsSync(out)) {
      return { ok: false, reason: `ffmpeg 無法產生合成影片：${(r.stderr || '').slice(-200)}`, dir, ffmpeg, videos: [] }
    }
    videos.push({ path: out, title: s.title, seconds: s.seconds })
  }
  return { ok: true, reason: '', dir, ffmpeg, videos }
}
