import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { buildThumbnailArgs, generateThumbnail, thumbnailPath } from './thumbnail'

const FAKE = path.resolve(__dirname, '../../test/fake-thumb-ffmpeg.mjs')
const ffmpeg = { bin: process.execPath, prefixArgs: [FAKE] }
let appData: string
let video: string
const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const k of ['APPDATA', 'FAKE_LOG', 'FAKE_EXIT']) saved[k] = process.env[k]
  appData = fs.mkdtempSync(path.join(os.tmpdir(), 'apexhl-thumb-'))
  process.env.APPDATA = appData
  process.env.FAKE_LOG = path.join(appData, 'log')
  delete process.env.FAKE_EXIT
  video = path.join(appData, 'v.mp4')
  fs.writeFileSync(video, 'x')
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  fs.rmSync(appData, { recursive: true, force: true })
})

describe('thumbnails (I14)', () => {
  it('scales to at most 320x180 keeping aspect ratio', () => {
    const args = buildThumbnailArgs('in.mp4', 'out.jpg', 12)
    const vf = args[args.indexOf('-vf') + 1]
    expect(vf).toBe('scale=320:180:force_original_aspect_ratio=decrease')
  })

  it('writes a temp file and renames it on success; passes the scale filter to ffmpeg', async () => {
    const out = await generateThumbnail(video, 100, { ffmpeg })
    expect(out).toBe(thumbnailPath(video))
    expect(fs.readFileSync(out!, 'utf-8')).toBe('jpg-data')
    expect(fs.readdirSync(path.dirname(out!))).toEqual([path.basename(out!)])
    const logged = JSON.parse(fs.readFileSync(process.env.FAKE_LOG!, 'utf-8').trim())
    expect(logged.args[logged.args.length - 1]).toMatch(/\.tmp\.jpg$/)
    expect(logged.args).toContain('-vf')
  })

  it('a failed ffmpeg leaves no half-written jpg that would later be reused', async () => {
    process.env.FAKE_EXIT = '1'
    expect(await generateThumbnail(video, 100, { ffmpeg })).toBeUndefined()
    expect(fs.existsSync(thumbnailPath(video))).toBe(false)
    expect(fs.readdirSync(path.dirname(thumbnailPath(video)))).toEqual([])
  })
})
