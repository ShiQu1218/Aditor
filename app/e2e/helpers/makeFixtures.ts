import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

export interface FixtureSet {
  ok: boolean
  /** Reason for skipping when ok=false. */
  reason: string
  dir: string
  ffmpeg: string | null
  videos: Array<{ path: string; title: string; seconds: number }>
}

/** Find ffmpeg using ADITOR_FFMPEG, then PATH; return null if unavailable. */
export function findFfmpeg(): string | null {
  const candidates: string[] = []
  if (process.env.ADITOR_FFMPEG) candidates.push(process.env.ADITOR_FFMPEG)
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

/** Generate three 10–20 second synthetic videos with testsrc2 (H.264 + silent AAC); no user videos are used. */
export function makeFixtures(): FixtureSet {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-e2e-fixtures-'))
  const ffmpeg = findFfmpeg()
  if (!ffmpeg) return { ok: false, reason: 'ffmpeg not found (PATH or ADITOR_FFMPEG); skipping E2E cases that require video', dir, ffmpeg: null, videos: [] }
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
      return { ok: false, reason: `ffmpeg could not generate synthetic videos: ${(r.stderr || '').slice(-200)}`, dir, ffmpeg, videos: [] }
    }
    videos.push({ path: out, title: s.title, seconds: s.seconds })
  }
  return { ok: true, reason: '', dir, ffmpeg, videos }
}
