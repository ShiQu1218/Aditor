/**
 * 用真的 ffmpeg／ffprobe 跑完整匯出（export-ipc → plan → run），驗證片段交界的時間戳。
 * 來源是合成影片：長 GOP（4 秒一個關鍵影格）＋ B-frame＋AAC，片段起點都不在關鍵影格上——
 * 正是舊版用 concat inpoint 時交界卡住、音訊多出、第一幀前出現空白 edit 的條件。
 * 合輯用 closed GOP（OBS／x264／NVENC 預設）；另用 open GOP 來源檢查單檔快速無損會丟掉解不出來的 leading B 幀。
 * 找不到 ffmpeg（APEXHL_FFMPEG、repo 的 build/ffmpeg/bin、PATH）就略過。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'child_process'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createExportService } from './export-ipc'
import { createCutLookup, createMediaEndProbe } from './keyframe'

const exe = process.platform === 'win32' ? '.exe' : ''

function findBin(name: 'ffmpeg' | 'ffprobe'): string | null {
  const candidates = [
    name === 'ffmpeg' ? process.env.APEXHL_FFMPEG : process.env.APEXHL_FFPROBE,
    process.env.APEXHL_FFMPEG ? path.join(path.dirname(process.env.APEXHL_FFMPEG), name + exe) : undefined,
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

/** 交界處不得有時間戳倒退、也不得有被擠成 1 tick 的封包（舊版 concat 會把重疊的封包壓在一起） */
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
      copyCut: createCutLookup(FFPROBE!),
      mediaEnd: createMediaEndProbe(FFPROBE!)
    })

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'apexhl-real-'))
    outDir = path.join(root, 'out')
    fs.mkdirSync(outDir)
    source = path.join(root, 'src.mp4')
    openGop = path.join(root, 'open.mp4')
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
  })
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

  for (const quality of ['copy', 'precise'] as const) {
    it(`concat (${quality}): first frame is a keyframe at time 0, timestamps continuous at every junction, A/V lengths match`, async () => {
      const r = await service().start(sender(), { items: items(), mode: 'concat', quality, encoder: 'mpeg4', outDir, baseName: `joined-${quality}` })
      expect(r.ok, JSON.stringify(r)).toBe(true)
      const out = path.join(outDir, `joined-${quality}.mp4`)
      // 中間檔都已清掉
      expect(fs.readdirSync(outDir).filter((f) => f.startsWith('.apexhl-seg'))).toEqual([])

      const info = streamInfo(out)
      const v = info.findIndex((s) => s.codec_type === 'video')
      const a = info.findIndex((s) => s.codec_type === 'audio')
      // 視訊從 0 開始：沒有前置的空白 edit（剪輯軟體顯示為第一幀全黑）
      expect(Number(info[v].start_time)).toBeCloseTo(0, 3)
      const pkts = packets(out)
      const firstVideo = pkts.find((p) => p.stream === v)!
      expect(firstVideo.key).toBe(true)
      expect(firstVideo.pts).toBeCloseTo(0, 3)

      expectCleanTimeline(pkts, v, 1 / FPS)
      expectCleanTimeline(pkts, a, 1024 / 48000)

      const end = (s: number) => Math.max(...pkts.filter((p) => p.stream === s).map((p) => p.pts + p.dur))
      const audioTotal = pkts.filter((p) => p.stream === a).reduce((sum, p) => sum + p.dur, 0)
      // 音訊不會比畫面多出一段（舊版每個交界多出最多一個 GOP 的聲音）
      expect(Math.abs(end(a) - end(v))).toBeLessThan(0.05)
      expect(audioTotal).toBeLessThan(end(v) + 0.05)

      const requested = items().reduce((s, it) => s + it.end - it.start, 0)
      if (quality === 'precise') expect(end(v)).toBeCloseTo(requested, 1)
      // 快速無損從關鍵影格切：只會比要求的長（最多每段一個 GOP）
      else expect(end(v)).toBeGreaterThanOrEqual(requested - 0.05)

      const dec = run(FFMPEG!, ['-v', 'error', '-i', out, '-f', 'null', '-'])
      expect(dec.stderr.trim()).toBe('')
    }, 60_000)
  }

  it('separate (copy, open GOP source): each file starts on a keyframe at time 0 without a pre-roll edit list', async () => {
    const clips = items().slice(0, 2).map((it) => ({ ...it, source: openGop }))
    const r = await service().start(sender(), { items: clips, mode: 'separate', quality: 'copy', outDir, baseName: 'each' })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    for (const n of [1, 2]) {
      const out = path.join(outDir, `each_${n}.mp4`)
      const pkts = packets(out)
      const info = streamInfo(out)
      const v = info.findIndex((s) => s.codec_type === 'video')
      const first = pkts.find((p) => p.stream === v)!
      expect(first.key).toBe(true)
      // 沒有被 edit list 藏起來（pts < 0）的前置畫面
      expect(Math.min(...pkts.filter((p) => p.stream === v).map((p) => p.pts))).toBeGreaterThanOrEqual(-0.001)
      expect(Number(info[v].start_time)).toBeCloseTo(0, 3)
      expect(run(FFMPEG!, ['-v', 'error', '-i', out, '-f', 'null', '-']).stderr.trim()).toBe('')
    }
  }, 60_000)
})
