import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { EventEmitter } from 'events'
import { PassThrough, Writable } from 'stream'
import { cutMatches, finalizeSession, selectMatchEntries } from './finalize'
import { createRecordingService } from './index'
import type { RecordingService, RecordingSettings } from '../../shared/recording'
import * as disk from './disk'
import { fakeCommand, fakeLiveCommand, makeDeps, sessionDir, tempRoot, waitFor } from './test-support'

const remux = vi.hoisted(() => ({ inputs: [] as string[], fail: false, failAt: 0,
  hold: false, release: null as (() => void) | null, active: 0, maxActive: 0 }))
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    spawn: (command: string, args: string[], options: any) => {
      if (command !== 'fake-ffmpeg') return actual.spawn(command, args, options)
      const proc = new EventEmitter() as any
      const chunks: Buffer[] = []
      proc.stdout = new PassThrough()
      proc.stderr = new PassThrough()
      proc.kill = () => {}
      proc.stdin = new Writable({
        write(chunk, _encoding, done) {
          chunks.push(Buffer.from(chunk))
          done()
        },
        final(done) {
          remux.inputs.push(Buffer.concat(chunks).toString())
          remux.active++
          remux.maxActive = Math.max(remux.active, remux.maxActive)
          const failed = remux.fail || remux.inputs.length === remux.failAt
          if (!failed) fs.writeFileSync(args.at(-1)!, Buffer.concat(chunks))
          done()
          const finish = () => {
            remux.active--
            proc.emit('close', failed ? 1 : 0)
          }
          if (remux.hold) remux.release = finish
          else setImmediate(finish)
        }
      })
      return proc
    }
  }
})

const roots: string[] = []
const services: RecordingService[] = []
afterEach(async () => {
  remux.hold = false
  remux.release?.()
  remux.release = null
  for (const service of services.splice(0)) await service.stop()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  remux.inputs = []
  remux.fail = false
  remux.failAt = 0
  remux.active = 0
  remux.maxActive = 0
})

const entries = Array.from({ length: 50 }, (_, i) => ({ seq: i + 1, pts: i * 2, dur: 2 }))
const matches = [{ start: 10, end: 18 }, { start: 70, end: 80 }]
const event = (t: number) => ({ id: `a${t}`, t, type: 'knock', score: 1, source: 'auto', counted: true })
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'))

function rig(postAnalysis: 'none' | 'afterExit' | 'perMatch' = 'none') {
  const root = tempRoot()
  roots.push(root)
  const deps = makeDeps(root)
  const dir = sessionDir(root)
  const startedAt = new Date(2026, 9, 18, 12, 34).getTime()
  fs.writeFileSync(path.join(dir, 'recording.json'), JSON.stringify({ startedAt, postAnalysis, mode: 'match' }))
  fs.writeFileSync(path.join(dir, 'init.mp4'), '初始化|')
  for (const entry of entries) fs.writeFileSync(path.join(dir, `seg_${String(entry.seq).padStart(6, '0')}.m4s`), `${entry.pts}|`)
  fs.writeFileSync(path.join(dir, 'index.jsonl'), entries.map((e) => JSON.stringify(e) + '\n').join(''))
  const live = {
    engine_version: '0.3.0', matches, events: [0, 6, 12, 24, 60, 66, 75, 86, 96].map(event),
    spectating: [{ start: 0, end: 7 }, { start: 21, end: 30 }, { start: 60, end: 67 }, { start: 83, end: 96 }],
    quality: { complete: false }, width: 1920, height: 1080
  }
  const saveLive = (value: object) => fs.writeFileSync(path.join(dir, 'live.json'), JSON.stringify(value))
  saveLive(live)
  deps.ffmpegPath = 'fake-ffmpeg'
  deps.addToLibrary = vi.fn()
  deps.enqueueAnalysis = vi.fn()
  deps.onLiveAnalysis = vi.fn()
  deps.liveCachePath = (output) => output + '.apexhl.json'
  return { root, dir, deps, live, saveLive, marker: () => read(path.join(dir, 'matches.json')) }
}

describe('逐局段落範圍', () => {
  it('前後各留五秒，嚴格排除只接觸邊界的段落', () => {
    expect(selectMatchEntries(entries, 11, 19)).toEqual(entries.slice(3, 12))
  })

  it.each([[0, 1, 0, 3], [97, 100, 46, 50], [0, 100, 0, 50]])('範圍 %s–%s 夾限於已錄段落', (start, end, first, last) => {
    expect(selectMatchEntries(entries, start, end)).toEqual(entries.slice(first, last))
  })

  it('一局完整位於單一段落內，空索引與不相交範圍也能處理', () => {
    const single = [{ seq: 1, pts: 0, dur: 30 }]
    expect(selectMatchEntries(single, 10, 11)).toEqual(single)
    expect(selectMatchEntries([], 10, 11)).toEqual([])
    expect(selectMatchEntries(entries, 120, 130)).toEqual([])
  })
})

describe('逐局剪檔與補收尾', () => {
  it('兩局輸出依段落時間命名，丟棄大廳，快取的事件／觀戰／對局各自位移與過濾', async () => {
    const r = rig()
    const outputs = await finalizeSession(r.dir, r.deps)
    expect(outputs.map((p) => path.basename(p))).toEqual(['Apex_2026-10-18_12-34.mp4', 'Apex_2026-10-18_12-35.mp4'])
    expect(remux.inputs).toEqual([
      '初始化|' + entries.slice(2, 12).map((e) => `${e.pts}|`).join(''),
      '初始化|' + entries.slice(32, 43).map((e) => `${e.pts}|`).join('')
    ])
    const docs = outputs.map((p) => read(r.deps.liveCachePath!(p)))
    expect(docs.map((d) => d.events.map((e: any) => [e.id, e.t]))).toEqual([
      [['a6', 2], ['a12', 8], ['a24', 20]], [['a66', 2], ['a75', 11], ['a86', 22]]
    ])
    expect(docs.map((d) => d.spectating)).toEqual([
      [{ start: 0, end: 3 }, { start: 17, end: 20 }], [{ start: 0, end: 3 }, { start: 19, end: 22 }]
    ])
    expect(docs.map((d) => d.live.matches)).toEqual([[{ start: 6, end: 14 }], [{ start: 6, end: 16 }]])
    expect(r.deps.addToLibrary).toHaveBeenCalledTimes(2)
    expect(r.deps.onLiveAnalysis).toHaveBeenCalledTimes(2)
    expect(r.deps.enqueueAnalysis).not.toHaveBeenCalled()
    expect(fs.existsSync(r.dir)).toBe(false)
  })

  it.each(['missing', 'empty'])('沒有對局（%s）保留整段', async (kind) => {
    const r = rig()
    if (kind === 'missing') fs.unlinkSync(path.join(r.dir, 'live.json'))
    else r.saveLive({ ...r.live, matches: [] })
    expect(await finalizeSession(r.dir, r.deps)).toHaveLength(1)
    expect(remux.inputs).toEqual(['初始化|' + entries.map((e) => `${e.pts}|`).join('')])
  })

  it('已剪過一局但 live.json 遺失，仍保留整段避免遺失其餘錄影', async () => {
    const r = rig()
    r.saveLive({ ...r.live, matches: [matches[0]] })
    const [cut] = await cutMatches(r.dir, r.deps)
    fs.unlinkSync(path.join(r.dir, 'live.json'))
    const [whole] = await finalizeSession(r.dir, r.deps)
    expect(whole).not.toBe(cut)
    expect(remux.inputs[1]).toBe('初始化|' + entries.map((e) => `${e.pts}|`).join(''))
    expect(r.deps.addToLibrary).toHaveBeenCalledWith([cut])
  })

  it.each([undefined, 'invalid'])('舊快照的 mode=%s 視為整段模式', async (mode) => {
    const r = rig()
    fs.writeFileSync(path.join(r.dir, 'recording.json'), JSON.stringify({ startedAt: Date.now(), postAnalysis: 'none', mode }))
    expect(await finalizeSession(r.dir, r.deps)).toHaveLength(1)
    expect(remux.inputs).toHaveLength(1)
    expect(remux.inputs[0]).toContain('98|')
  })

  it('收尾關閉最後一個未結束的對局，不必等後五秒', async () => {
    const r = rig()
    r.saveLive({ ...r.live, matches: [{ start: 97, end: null }] })
    expect(await cutMatches(r.dir, r.deps)).toEqual([])
    const [output] = await finalizeSession(r.dir, r.deps)
    expect(remux.inputs).toEqual(['初始化|92|94|96|98|'])
    expect(read(r.deps.liveCachePath!(output)).live.matches).toEqual([{ start: 5, end: 8 }])
  })

  it('同分鐘的輸出沿用碰撞序號', async () => {
    const r = rig()
    r.saveLive({ ...r.live, matches: [{ start: 10, end: 18 }, { start: 30, end: 40 }] })
    const outputs = await finalizeSession(r.dir, r.deps)
    expect(outputs[1]).toBe(outputs[0].replace('.mp4', '_2.mp4'))
  })

  it('後留段落尚未到齊不剪；到齊後剪一次，錄影中不信任最終品質', async () => {
    const r = rig('perMatch')
    r.saveLive({ ...r.live, matches: [matches[0]], quality: { complete: true } })
    const index = path.join(r.dir, 'index.jsonl')
    fs.writeFileSync(index, entries.slice(0, 12).map((e) => JSON.stringify(e) + '\n').join(''))
    expect(await cutMatches(r.dir, r.deps)).toEqual([])
    fs.appendFileSync(index, JSON.stringify(entries[12]) + '\n')
    const [output] = await cutMatches(r.dir, r.deps)
    expect(read(r.deps.liveCachePath!(output)).analysis.engine_version).toBe('live-0.3.0')
    expect(r.marker().cuts[0]).toMatchObject({ index: 0, start: 10, end: 18, firstSeq: 3, lastSeq: 12, outputPath: output,
      analysisQueued: true, liveCached: true, liveTrusted: false })
    expect(r.deps.enqueueAnalysis).toHaveBeenCalledWith(output)
    expect(await cutMatches(r.dir, r.deps)).toEqual([])
    expect(await finalizeSession(r.dir, r.deps)).toEqual([])
    expect(r.deps.enqueueAnalysis).toHaveBeenCalledOnce()
    expect(remux.inputs).toHaveLength(1)
  })

  it('剪檔失敗保留段落，收尾重試', async () => {
    const r = rig()
    remux.fail = true
    await expect(cutMatches(r.dir, r.deps)).rejects.toThrow('串接失敗')
    expect(fs.existsSync(path.join(r.dir, 'seg_000001.m4s'))).toBe(true)
    remux.fail = false
    expect(await finalizeSession(r.dir, r.deps)).toHaveLength(2)
  })

  it('後續剪檔失敗仍即時通知先完成的剪檔', async () => {
    const r = rig()
    remux.failAt = 2
    const saved = vi.fn()
    await expect(cutMatches(r.dir, r.deps, { onCut: saved })).rejects.toThrow('串接失敗')
    expect(saved).toHaveBeenCalledOnce()
    expect(fs.existsSync(saved.mock.calls[0][0])).toBe(true)
    remux.failAt = 0
    expect(await finalizeSession(r.dir, r.deps)).toHaveLength(1)
  })

  it('marker 寫入失敗不留下正式影片，重試不增加重複檔名', async () => {
    const r = rig()
    const rename = fs.promises.rename.bind(fs.promises)
    const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('matches.json')) throw new Error('模擬 marker 寫入失敗')
      await rename(from, to)
    })
    await expect(cutMatches(r.dir, r.deps)).rejects.toThrow('marker')
    expect(fs.readdirSync(path.dirname(path.dirname(r.dir))).filter((p) => p.endsWith('.mp4'))).toEqual([])
    spy.mockRestore()
    expect((await finalizeSession(r.dir, r.deps)).map((p) => path.basename(p)))
      .toEqual(['Apex_2026-10-18_12-34.mp4', 'Apex_2026-10-18_12-35.mp4'])
  })

  it('串接完成但 marker 尚未寫入就中斷，重跑會刪除暫存檔且不重複產檔', async () => {
    const r = rig()
    const output = path.join(r.root, 'videos', 'Apex_2026-10-18_12-34.mp4')
    const part = output.replace('.mp4', '.part.mp4')
    fs.writeFileSync(part, '尚未登記的剪檔')
    fs.writeFileSync(path.join(r.dir, 'match-part.json'), JSON.stringify({ output, part }))
    expect(await finalizeSession(r.dir, r.deps)).toHaveLength(2)
    expect(fs.existsSync(part)).toBe(false)
    expect(fs.readdirSync(path.dirname(output)).filter((p) => p.endsWith('.mp4'))).toHaveLength(2)
    expect(remux.inputs).toHaveLength(2)
  })

  it('marker 必須早於改名與副作用落盤；改名中斷可直接續用已串接的檔案', async () => {
    const r = rig()
    const rename = fs.promises.rename.bind(fs.promises)
    let interrupted = false
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(from).endsWith('.part.mp4') && !interrupted) {
        interrupted = true
        expect(r.marker().cuts).toHaveLength(1)
        expect(r.deps.addToLibrary).not.toHaveBeenCalled()
        throw new Error('模擬改名時中斷')
      }
      await rename(from, to)
    })
    await expect(finalizeSession(r.dir, r.deps)).rejects.toThrow('中斷')
    const outputs = await finalizeSession(r.dir, r.deps)
    expect(outputs).toHaveLength(1)
    expect(remux.inputs).toHaveLength(2)
    expect(r.deps.addToLibrary).toHaveBeenCalledTimes(2)
  })

  it('最終可信結果重寫自己的 live 快取，略過 afterExit，並補加所有既有剪檔', async () => {
    const r = rig('afterExit')
    const outputs = await cutMatches(r.dir, r.deps)
    expect(r.deps.enqueueAnalysis).not.toHaveBeenCalled()
    r.saveLive({ ...r.live, quality: { complete: true, hScale: 1.05 } })
    r.deps.addToLibrary = vi.fn()
    const rm = vi.spyOn(fs.promises, 'rm').mockRejectedValueOnce(new Error('保留 marker 供檢查'))
    await expect(finalizeSession(r.dir, r.deps)).rejects.toThrow('供檢查')
    for (const output of outputs) {
      expect(read(r.deps.liveCachePath!(output)).analysis).toMatchObject({ source: 'live', engine_version: '0.3.0', h_scale: 1.05 })
      expect(r.deps.addToLibrary).toHaveBeenCalledWith([output])
    }
    expect(r.marker().cuts.every((c: any) => c.liveTrusted)).toBe(true)
    expect(r.deps.enqueueAnalysis).not.toHaveBeenCalled()
    rm.mockRestore()
    expect(await finalizeSession(r.dir, r.deps)).toEqual([])
  })

  it('最終可信結果不覆蓋完整分析快取', async () => {
    const r = rig('afterExit')
    const outputs = await cutMatches(r.dir, r.deps)
    const full = JSON.stringify({ analysis: { source: 'full', engine_version: '0.3.0' }, events: [event(3)] })
    fs.writeFileSync(r.deps.liveCachePath!(outputs[0]), full)
    r.saveLive({ ...r.live, quality: { complete: true } })
    await finalizeSession(r.dir, r.deps)
    expect(fs.readFileSync(r.deps.liveCachePath!(outputs[0]), 'utf8')).toBe(full)
    expect(r.deps.enqueueAnalysis).not.toHaveBeenCalled()
  })

  it.each(['afterExit', 'perMatch'] as const)('不可信結果的 %s 每局只排一次，重跑不重新通知舊剪檔', async (postAnalysis) => {
    const r = rig(postAnalysis)
    const outputs = await cutMatches(r.dir, r.deps)
    expect(r.deps.enqueueAnalysis).toHaveBeenCalledTimes(postAnalysis === 'perMatch' ? 2 : 0)
    vi.spyOn(fs.promises, 'rm').mockRejectedValueOnce(new Error('模擬刪除前中斷'))
    await expect(finalizeSession(r.dir, r.deps)).rejects.toThrow('中斷')
    expect(await finalizeSession(r.dir, r.deps)).toEqual([])
    expect(r.deps.enqueueAnalysis).toHaveBeenCalledTimes(2)
    for (const output of outputs) expect(r.deps.enqueueAnalysis).toHaveBeenCalledWith(output)
    expect(remux.inputs).toHaveLength(2)
  })
})

describe('逐局錄影服務', () => {
  function serviceRig(liveMode = 'closed-match', tailSegments = 2) {
    const r = rig('perMatch')
    fs.rmSync(r.dir, { recursive: true })
    const source = path.join(r.root, 'segments')
    fs.mkdirSync(source)
    fs.copyFileSync(path.join(__dirname, '__fixtures__', 'init-h264.mp4'), path.join(source, 'init.mp4'))
    const gate = path.join(r.root, 'post-pad-ready')
    const trace = path.join(r.root, 'recorder.jsonl')
    const settings: RecordingSettings = { ...r.deps.getSettings(), mode: 'match', postAnalysis: 'perMatch' }
    r.deps.getSettings = () => settings
    r.deps.notify = vi.fn()
    r.deps.recorderCommand = fakeCommand('match', { FAKE_SEGMENT_DIR: source, FAKE_POST_PAD_GATE: gate,
      FAKE_RECORDER_TRACE: trace, FAKE_TAIL_SEGMENTS: String(tailSegments) })
    r.deps.liveEngineCommand = fakeLiveCommand(liveMode)
    vi.spyOn(disk, 'diskFreeBytes').mockResolvedValue(100 * 1024 ** 3)
    const service = createRecordingService(r.deps)
    services.push(service)
    const finalized = vi.fn()
    service.onFinalized(finalized)
    service.start()
    return { ...r, service, finalized, settings, gate, trace }
  }

  it('閉合對局等後留段落落盤才剪，持續錄影與觀看，不重啟或重複通知', async () => {
    const r = serviceRig()
    const { service, finalized } = r
    await waitFor(() => service.status().matchIndex === 1)
    await waitFor(() => service.status().durationSec === 8)
    const before = (await service.live!())!
    expect(before.matches).toEqual([{ start: 0.5, end: 3 }])
    expect(finalized).not.toHaveBeenCalled()
    const dir = path.join(r.deps.defaultOutputDir, '.sessions', before.sessionId)
    expect(read(path.join(dir, 'recording.json')).mode).toBe('match')
    r.settings.mode = 'session'
    r.settings.postAnalysis = 'none'
    fs.writeFileSync(r.gate, '')
    await waitFor(() => finalized.mock.calls.length === 1)
    expect(service.status().phase).toBe('recording')
    expect((await service.live!())!.sessionId).toBe(before.sessionId)
    expect((await service.live!())!.segments).toHaveLength(6)
    expect(r.deps.enqueueAnalysis).toHaveBeenCalledOnce()
    await service.stopManual()
    expect(finalized).toHaveBeenCalledOnce()
    expect(remux.inputs).toHaveLength(1)
    expect(fs.readFileSync(r.trace, 'utf8').split('\n').filter((line) => line && JSON.parse(line).cmd === 'start')).toHaveLength(1)
  })

  it('慢速剪檔不阻擋段落與事件，兩局只會序列執行 ffmpeg', async () => {
    const r = serviceRig('two-matches', 3)
    await waitFor(() => r.service.status().matchIndex === 2)
    remux.hold = true
    fs.writeFileSync(r.gate, '')
    await waitFor(() => remux.release !== null)
    await waitFor(() => r.service.status().segments === 7)
    expect(r.service.status().phase).toBe('recording')
    expect((await r.service.live!())!.matches).toHaveLength(2)
    expect(remux.inputs).toHaveLength(1)
    remux.hold = false
    remux.release!()
    remux.release = null
    await waitFor(() => r.finalized.mock.calls.length === 2)
    expect(remux.inputs).toHaveLength(2)
    expect(remux.maxActive).toBe(1)
    await r.service.stopManual()
    expect(r.finalized).toHaveBeenCalledTimes(2)
  })

  it('錄影中剪檔失敗會通知但保持錄影，停止後重試成功', async () => {
    const r = serviceRig()
    await waitFor(() => r.service.status().matchIndex === 1)
    remux.fail = true
    fs.writeFileSync(r.gate, '')
    await waitFor(() => vi.mocked(r.deps.notify).mock.calls.some(([kind, message]) => kind === 'error' && message.includes('逐局剪檔失敗')))
    expect(r.service.status().phase).toBe('recording')
    expect(r.finalized).not.toHaveBeenCalled()
    remux.fail = false
    await r.service.stopManual()
    expect(r.service.status().phase).toBe('idle')
    expect(r.finalized).toHaveBeenCalledOnce()
    expect(r.deps.enqueueAnalysis).toHaveBeenCalledOnce()
  })

  it('一局剪檔失敗不拖延後面的對局，失敗局只在收尾重試', async () => {
    const r = serviceRig('two-matches', 3)
    await waitFor(() => r.service.status().matchIndex === 2)
    remux.failAt = 1
    fs.writeFileSync(r.gate, '')
    await waitFor(() => r.finalized.mock.calls.length === 1)
    expect(r.service.status().phase).toBe('recording')
    expect(remux.inputs).toHaveLength(2)
    expect(r.deps.enqueueAnalysis).toHaveBeenCalledOnce()
    await r.service.stopManual()
    expect(remux.inputs).toHaveLength(3)
    expect(r.finalized).toHaveBeenCalledTimes(2)
    expect(r.deps.enqueueAnalysis).toHaveBeenCalledTimes(2)
  })
})
