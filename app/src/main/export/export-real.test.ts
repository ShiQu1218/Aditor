/**
 * Run a complete export with real ffmpeg/ffprobe (export-ipc → plan → run) and verify timestamps at clip boundaries.
 * Source videos are synthetic: long GOP (one keyframe every 4 seconds) + B-frames + AAC, with clip starts away from keyframes—
 * the conditions that caused the old concat inpoint implementation to stall at boundaries, add audio, and create a blank edit before the first frame.
 * Use closed GOP for concatenation (OBS/x264/NVENC defaults); also use an open-GOP source to check that single-file fast stream copy preserves leading B-frames that cannot be decoded.
 * Skip when ffmpeg cannot be found (ADITOR_FFMPEG, repo build/ffmpeg/bin, or PATH).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'child_process'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createExportService } from './export-ipc'
import { createAudioProbe, createCutLookup, createMediaEndProbe } from './keyframe'

const exe = process.platform === 'win32' ? '.exe' : ''

function findBin(name: 'ffmpeg' | 'ffprobe'): string | null {
  const candidates = [
    name === 'ffmpeg' ? process.env.ADITOR_FFMPEG : process.env.ADITOR_FFPROBE,
    process.env.ADITOR_FFMPEG ? path.join(path.dirname(process.env.ADITOR_FFMPEG), name + exe) : undefined,
    path.resolve(__dirname, '../../../../build/ffmpeg/bin', name + exe),
    name
  ].filter((c): c is string => !!c)
  for (const c of candidates) {
    if (spawnSync(c, ['-version'], { windowsHide: true }).status === 0) return c
  }
  return null
}

const FFMPEG = findBin('ffmpeg')
const FFPROBE = findBin('ffprobe')
const run = (bin: string, args: string[]) => spawnSync(bin, args, { encoding: 'utf-8', windowsHide: true, maxBuffer: 1 << 26 })

interface Pkt {
  stream: number
  pts: number
  dts: number
  dur: number
  key: boolean
}
function packets(file: string): Pkt[] {
  const r = run(FFPROBE!, ['-v', 'error', '-show_entries', 'packet=stream_index,pts_time,dts_time,duration_time,flags', '-of', 'csv=p=0', file])
  return r.stdout
    .trim()
    .split(/\r?\n/)
    .map((l) => l.split(','))
    .map(([s, pts, dts, dur, flags]) => ({ stream: Number(s), pts: Number(pts), dts: Number(dts), dur: Number(dur), key: flags.startsWith('K') }))
}
function streamInfo(file: string): Array<{ codec_type: string; start_time: string }> {
  return JSON.parse(run(FFPROBE!, ['-v', 'error', '-show_entries', 'stream=codec_type,start_time', '-of', 'json', file]).stdout).streams
}

/** Clip boundaries must have no backward timestamps or packets compressed to 1 tick (old concat overlapped packets). */
function expectCleanTimeline(pkts: Pkt[], stream: number, frame: number): void {
  const s = pkts.filter((p) => p.stream === stream)
  for (let i = 1; i < s.length; i++) {
    const step = s[i].dts - s[i - 1].dts
    expect(step, `stream ${stream} dts ${s[i - 1].dts} -> ${s[i].dts}`).toBeGreaterThan(frame / 2)
    expect(step, `stream ${stream} gap at ${s[i - 1].dts}`).toBeLessThan(frame * 2.5)
  }
}

const describeReal = FFMPEG && FFPROBE ? describe : describe.skip

describeReal('real ffmpeg export: clip junctions play cleanly', () => {
  let root: string
  let outDir: string
  let source: string
  let openGop: string
  let silent: string
  const FPS = 30
  const items = () => [
    { id: '1', source, start: 5.3, end: 9.2 },
    { id: '2', source, start: 14.6, end: 18.1 },
    { id: '3', source, start: 2.1, end: 4.4 }
  ]
  const sender = () => Object.assign(new EventEmitter(), { isDestroyed: () => false, send: () => undefined })
  const service = () =>
    createExportService({
      ffmpeg: { bin: FFMPEG! },
      tempDir: path.join(root, 'tmp'),
      probe: async () => ({ codec: 'mpeg4', width: 320, height: 240 }),
      hasAudio: createAudioProbe(FFPROBE!),
      copyCut: createCutLookup(FFPROBE!),
      mediaEnd: createMediaEndProbe(FFPROBE!)
    })

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-real-'))
    outDir = path.join(root, 'out')
    fs.mkdirSync(outDir)
    source = path.join(root, 'src.mp4')
    openGop = path.join(root, 'open.mp4')
    silent = path.join(root, 'silent.mp4')
    for (const [file, gopFlags] of [[source, ['-flags', '+cgop', '-sc_threshold', '1000000000']], [openGop, []]] as const) {
      const r = run(FFMPEG!, [
        '-v', 'error', '-y',
        '-f', 'lavfi', '-i', `testsrc2=size=320x240:rate=${FPS}:duration=24`,
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=24',
        '-c:v', 'mpeg4', '-bf', '2', '-g', String(FPS * 4), ...gopFlags, '-q:v', '5',
        '-c:a', 'aac', '-b:a', '96k', '-shortest', file
      ])
      expect(r.status, r.stderr).toBe(0)
    }
    const noAudio = run(FFMPEG!, ['-v', 'error', '-y', '-i', source, '-map', '0:v:0', '-c:v', 'copy', '-an', silent])
    expect(noAudio.status, noAudio.stderr).toBe(0)
  })
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

  it('concat stream copy repairs INT_MAX source timescales and stays decodable', async () => {
    const high = path.join(root, 'high-timescale.mp4')
    const remux = run(FFMPEG!, ['-v', 'error', '-y', '-i', source, '-c', 'copy', '-video_track_timescale', '2147483641', high])
    expect(remux.status, remux.stderr).toBe(0)
    const r = await service().start(sender(), {
      items: [{ id: 'high', source: high, start: 0, end: 8 }],
      mode: 'concat', quality: 'copy', outDir, baseName: 'high-timescale'
    })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const out = path.join(outDir, 'Merged', 'high-timescale.mp4')
    const timing = JSON.parse(run(FFPROBE!, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=time_base,r_frame_rate', '-of', 'json', out]).stdout)
    expect(timing.streams[0]).toMatchObject({ time_base: '1/90000', r_frame_rate: '30/1' })
    expectCleanTimeline(packets(out), 0, 1 / FPS)
    const decoded = run(FFMPEG!, ['-v', 'error', '-i', out, '-f', 'null', '-'])
    expect(decoded.status, decoded.stderr).toBe(0)
    expect(decoded.stderr.trim()).toBe('')
  })

  for (const quality of ['copy', 'precise'] as const) {
    it(`concat (${quality}): first frame is a keyframe at time 0, timestamps continuous at every junction, A/V lengths match`, async () => {
      const r = await service().start(sender(), { items: items(), mode: 'concat', quality, encoder: 'mpeg4', outDir, baseName: `joined-${quality}` })
      expect(r.ok, JSON.stringify(r)).toBe(true)
      const out = path.join(outDir, 'Merged', `joined-${quality}.mp4`)
      // All intermediate files have been removed.
      expect(fs.readdirSync(path.join(outDir, 'Merged')).filter((f) => f.startsWith('.aditor-seg'))).toEqual([])

      const info = streamInfo(out)
      const timing = JSON.parse(run(FFPROBE!, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=time_base', '-of', 'json', out]).stdout)
      expect(timing.streams[0].time_base).toBe('1/90000')
      const v = info.findIndex((s) => s.codec_type === 'video')
      const a = info.findIndex((s) => s.codec_type === 'audio')
      // Video starts at 0: no leading blank edit (which appears as a black first frame in editing software).
      expect(Number(info[v].start_time)).toBeCloseTo(0, 3)
      const pkts = packets(out)
      const firstVideo = pkts.find((p) => p.stream === v)!
      expect(firstVideo.key).toBe(true)
      expect(firstVideo.pts).toBeCloseTo(0, 3)

      expectCleanTimeline(pkts, v, 1 / FPS)
      expectCleanTimeline(pkts, a, 1024 / 48000)

      const end = (s: number) => Math.max(...pkts.filter((p) => p.stream === s).map((p) => p.pts + p.dur))
      const audioTotal = pkts.filter((p) => p.stream === a).reduce((sum, p) => sum + p.dur, 0)
      // Audio does not run past the video (the old implementation added up to one GOP of audio at every boundary).
      expect(Math.abs(end(a) - end(v))).toBeLessThan(0.05)
      expect(audioTotal).toBeLessThan(end(v) + 0.05)

      const requested = items().reduce((s, it) => s + it.end - it.start, 0)
      if (quality === 'precise') expect(end(v)).toBeCloseTo(requested, 1)
      // Fast stream copy cuts at keyframes, so it can only exceed the requested duration (by at most one GOP per segment).
      else expect(end(v)).toBeGreaterThanOrEqual(requested - 0.05)

      const dec = run(FFMPEG!, ['-v', 'error', '-i', out, '-f', 'null', '-'])
      expect(dec.stderr.trim()).toBe('')
    }, 60_000)
  }

  it.each(['first', 'middle', 'last', 'all'])('precise concat fills missing audio with silence (%s)', async (position) => {
    const sources = position === 'first' ? [silent, source] : position === 'middle' ? [source, silent, source]
      : position === 'last' ? [source, silent] : [silent, silent]
    const clips = sources.map((file, i) => ({ id: String(i), source: file, start: 0.4, end: 1.4 }))
    const result = await service().start(sender(), { items: clips, mode: 'concat', quality: 'precise', encoder: 'mpeg4', outDir, baseName: `audio-${position}` })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    const info = streamInfo(result.outputs[0])
    expect(info.map((s) => s.codec_type)).toEqual(['video', 'audio'])
    const pkts = packets(result.outputs[0])
    const end = (stream: number) => Math.max(...pkts.filter((p) => p.stream === stream).map((p) => p.pts + p.dur))
    expect(end(0)).toBeCloseTo(sources.length, 1)
    expect(Math.abs(end(1) - end(0))).toBeLessThan(0.05)
    expectCleanTimeline(pkts, 1, 1024 / 48000)

    const decoded = spawnSync(FFMPEG!, ['-v', 'error', '-i', result.outputs[0], '-vn', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'], { windowsHide: true })
    expect(decoded.status, decoded.stderr.toString()).toBe(0)
    sources.forEach((file, i) => {
      let power = 0
      const from = Math.round((i + 0.25) * 48000)
      const to = Math.round((i + 0.75) * 48000)
      expect(decoded.stdout.length).toBeGreaterThanOrEqual(to * 2)
      for (let sample = from; sample < to; sample++) power += decoded.stdout.readInt16LE(sample * 2) ** 2
      const rms = Math.sqrt(power / (to - from))
      if (file === silent) expect(rms).toBeLessThan(100)
      else expect(rms).toBeGreaterThan(200)
    })
  }, 60_000)

  it('separate (copy, open GOP source): each file starts on a keyframe at time 0 without a pre-roll edit list', async () => {
    const clips = items().slice(0, 2).map((it) => ({ ...it, source: openGop }))
    const r = await service().start(sender(), { items: clips, mode: 'separate', quality: 'copy', outDir, baseName: 'each' })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    for (const n of [1, 2]) {
      const out = path.join(outDir, 'Clips', `each_${n}.mp4`)
      const pkts = packets(out)
      const info = streamInfo(out)
      const v = info.findIndex((s) => s.codec_type === 'video')
      const first = pkts.find((p) => p.stream === v)!
      expect(first.key).toBe(true)
      // No leading frames are hidden by an edit list (pts < 0).
      expect(Math.min(...pkts.filter((p) => p.stream === v).map((p) => p.pts))).toBeGreaterThanOrEqual(-0.001)
      expect(Number(info[v].start_time)).toBeCloseTo(0, 3)
      expect(run(FFMPEG!, ['-v', 'error', '-i', out, '-f', 'null', '-']).stderr.trim()).toBe('')
    }
  }, 60_000)
})
