import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { createRecordingService, type RecordingDeps } from './index'
import type { RecordingService, RecordingSettings } from '../../shared/recording'
import * as disk from './disk'
import { copySegments, createSegments, fakeCommand, ffmpeg, makeDeps, sessionDir, tempRoot, waitFor } from './test-support'

interface Rig {
  root: string
  deps: RecordingDeps
  settings: RecordingSettings
  service: RecordingService
  trace: string
  pid: number | null
}
const rigs: Rig[] = []
function rig(mode = 'normal'): Rig {
  const root = tempRoot()
  const deps = makeDeps(root)
  const settings = { ...deps.getSettings() }
  const trace = path.join(root, 'trace.jsonl')
  deps.getSettings = () => settings
  deps.notify = vi.fn(); deps.addToLibrary = vi.fn(); deps.enqueueAnalysis = vi.fn()
  deps.recorderCommand = fakeCommand(mode, { FAKE_RECORDER_TRACE: trace })
  const value = { root, deps, settings, trace, pid: 1234 } as Rig
  deps.findApexPid = vi.fn(async () => value.pid)
  value.service = createRecordingService(deps)
  vi.spyOn(disk, 'diskFreeBytes').mockResolvedValue(100 * 1024 ** 3)
  rigs.push(value)
  return value
}
function commands(value: Rig, cmd: string): Record<string, any>[] {
  return fs.existsSync(value.trace) ? fs.readFileSync(value.trace, 'utf8').trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line)).filter((entry) => entry.cmd === cmd) : []
}
afterEach(async () => {
  for (const value of rigs.splice(0)) {
    await value.service.stop()
    fs.rmSync(value.root, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('錄影服務狀態機', () => {
  it('自動開始／結束、ROI 與影音設定、段落／丟格統計及不可變快照', async () => {
    const value = rig()
    value.settings.height = 1080; value.settings.micEnabled = false; value.settings.micGain = 0.4
    value.settings.renderDevice = 'speaker'; value.settings.captureDevice = 'mic'; value.settings.captureMethod = 'dda'
    value.service.start()
    await waitFor(() => value.service.status().segments === 2)
    const snapshot = value.service.status()
    expect(snapshot).toMatchObject({ phase: 'recording', encoder: 'hevc_nvenc', width: 1920, height: 1080, durationSec: 4, droppedFrames: 3 })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(snapshot.sessionId).toMatch(/^\d{8}-\d{6}-[0-9a-f]{4}$/)
    const [start] = commands(value, 'start')
    expect(start.frames).toEqual({ banner: [560, 700, 800, 180], spec: [60, 1028, 480, 40], base: [1920, 1080] })
    expect(start.encode).toMatchObject({ height: 1080, codec: 'hevc', bitrate_kbps: 10000, preset: 'speed', aspect: 'native' })
    expect(start.audio).toEqual({ render: 'speaker', capture: 'mic', mic_enabled: false, mic_gain: 0.4,
      render_enabled: true, render_gain: 1, render_source: 'device', mic_mono: false })
    expect(start.capture).toBe('dda')
    await waitFor(() => fs.existsSync(path.join(start.session_dir, 'events.jsonl')) &&
      fs.readFileSync(path.join(start.session_dir, 'events.jsonl'), 'utf8').includes('window_lost'))
    expect(fs.readFileSync(path.join(start.session_dir, 'events.jsonl'), 'utf8')).toContain('window_lost')
    value.pid = null
    await waitFor(() => value.service.status().phase === 'idle')
    expect(commands(value, 'stop')).toHaveLength(1)
    expect(snapshot.phase).toBe('recording')
    expect(fs.existsSync(start.session_dir)).toBe(false)
  })

  it.each(['fit', 'stretch'] as const)('新影音設定完整傳入 start：%s', async (aspectMode) => {
    const value = rig()
    Object.assign(value.settings, { fps: 20, preset: 'quality', forceAspect: true, aspectMode,
      systemAudioEnabled: false, systemGain: 0.35, gameAudioOnly: true, micMono: true })
    value.service.start()
    await waitFor(() => value.service.status().phase === 'recording')
    const [start] = commands(value, 'start')
    expect(start.encode).toMatchObject({ fps: 20, preset: 'quality', aspect: aspectMode })
    expect(start.audio).toMatchObject({ render_enabled: false, render_gain: 0.35, render_source: 'game', mic_mono: true })
  })

  it('錄影器警告顯示非致命通知，持續錄影且不重啟', async () => {
    const value = rig('warning')
    value.service.start()
    await waitFor(() => vi.mocked(value.deps.notify).mock.calls.some(([kind]) => kind === 'warning'))
    expect(value.service.status()).toMatchObject({ phase: 'recording', error: null })
    expect(commands(value, 'start')).toHaveLength(1)
    expect(commands(value, 'stop')).toHaveLength(0)
  })

  it('偵測到 Apex 後先等遊戲啟動穩定才開始擷取，避開啟動與反作弊載入階段', async () => {
    const value = rig()
    value.deps.gameStartDelayMs = 400
    value.service = createRecordingService(value.deps)
    const startedAt = Date.now()
    value.service.start()
    await waitFor(() => commands(value, 'start').length > 0, 5000)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(400)
  })
  it('遊戲重開（新 PID）重新計算等待時間', async () => {
    const value = rig()
    value.deps.gameStartDelayMs = 300
    value.service = createRecordingService(value.deps)
    value.service.start()
    await waitFor(() => commands(value, 'start').length === 1, 5000)
    value.pid = null
    await waitFor(() => value.service.status().phase === 'idle', 5000)
    value.pid = 5678
    const restartedAt = Date.now()
    await waitFor(() => commands(value, 'start').length === 2, 5000)
    expect(Date.now() - restartedAt).toBeGreaterThanOrEqual(300)
  })
  it('暫停阻止自動錄影，恢復後開始；手動停止不會在下一次輪詢立即重開', async () => {
    const value = rig()
    value.service.setPaused(true)
    value.service.start()
    await waitFor(() => vi.mocked(value.deps.findApexPid!).mock.calls.length >= 3)
    expect(commands(value, 'start')).toHaveLength(0)
    value.service.setPaused(false)
    await waitFor(() => value.service.status().phase === 'recording')
    value.service.setPaused(true)
    expect(value.service.status().phase).toBe('recording')
    await value.service.stopManual()
    value.service.setPaused(false)
    const polls = vi.mocked(value.deps.findApexPid!).mock.calls.length
    await waitFor(() => vi.mocked(value.deps.findApexPid!).mock.calls.length >= polls + 3)
    expect(commands(value, 'start')).toHaveLength(1)
    expect(value.service.status().phase).toBe('idle')
    expect(await value.service.startManual()).toBe(true)
    await value.service.stopManual()
    expect(commands(value, 'start')).toHaveLength(2)
  })

  it('手動開始不受 autoRecord／暫停限制；Apex 未執行時回 false', async () => {
    const value = rig(); value.settings.autoRecord = false; value.pid = null
    value.service.start(); value.service.setPaused(true)
    expect(await value.service.startManual()).toBe(false)
    value.pid = 1234
    expect(await value.service.startManual()).toBe(true)
    expect(value.service.status()).toMatchObject({ phase: 'recording', paused: true })
    await value.service.stopManual()
  })

  it('autoRecord 設定變更不需重啟；輸出資料夾依監看資料夾選擇', async () => {
    const value = rig(); value.settings.autoRecord = false
    const watch = path.join(value.root, 'watch')
    value.deps.getWatchFolders = () => [watch]
    value.service.start()
    await waitFor(() => vi.mocked(value.deps.findApexPid!).mock.calls.length >= 3)
    expect(commands(value, 'start')).toHaveLength(0)
    value.settings.autoRecord = true
    await waitFor(() => value.service.status().phase === 'recording')
    expect(commands(value, 'start')[0].session_dir).toContain(path.join(watch, '.sessions'))
    expect(fs.existsSync(watch)).toBe(true)
  })

  it.each(['no-hw', 'async-no-hw'])('無硬體編碼器直接 error 且不重試：%s', async (mode) => {
    const value = rig(mode)
    value.service.start()
    await waitFor(() => value.service.status().error?.code === 'no_hw_encoder')
    const polls = vi.mocked(value.deps.findApexPid!).mock.calls.length
    await waitFor(() => vi.mocked(value.deps.findApexPid!).mock.calls.length >= polls + 3)
    expect(commands(value, 'start')).toHaveLength(1)
    expect(value.deps.notify).toHaveBeenCalledWith('error', expect.stringContaining('硬體編碼器'))
    expect(Object.isFrozen(value.service.status().error)).toBe(true)
  })

  it('崩潰採 1/2/4/8/16 秒退避，10 分鐘內最多重啟 5 次', async () => {
    vi.useFakeTimers()
    const value = rig('crash')
    value.settings.autoRecord = false
    value.service.start()
    expect(await value.service.startManual()).toBe(true)
    for (const [i, seconds] of [1, 2, 4, 8, 16].entries()) {
      await waitFor(() => value.service.status().phase === 'error')
      await vi.advanceTimersByTimeAsync(seconds * 1000 - 1)
      expect(commands(value, 'start')).toHaveLength(i + 1)
      await vi.advanceTimersByTimeAsync(1)
      await waitFor(() => commands(value, 'start').length === i + 2)
      await waitFor(() => value.service.status().phase === 'error')
    }
    await waitFor(() => value.service.status().error?.code === 'restart_limit')
    expect(commands(value, 'start')).toHaveLength(6)
    await vi.advanceTimersByTimeAsync(60000)
    expect(commands(value, 'start')).toHaveLength(6)
  }, 15000)

  it('磁碟提醒一次，低於停止門檻則停止且不自動重開', async () => {
    vi.useFakeTimers()
    const value = rig()
    value.settings.autoRecord = false
    vi.mocked(disk.diskFreeBytes).mockResolvedValue(5 * 1024 ** 3)
    value.service.start()
    expect(await value.service.startManual()).toBe(true)
    await waitFor(() => vi.mocked(value.deps.notify).mock.calls.some(([kind]) => kind === 'diskWarn'))
    await vi.advanceTimersByTimeAsync(30000)
    await waitFor(() => vi.mocked(disk.diskFreeBytes).mock.calls.length >= 3)
    expect(vi.mocked(value.deps.notify).mock.calls.filter(([kind]) => kind === 'diskWarn')).toHaveLength(1)
    vi.mocked(disk.diskFreeBytes).mockResolvedValue(1024 ** 3)
    await vi.advanceTimersByTimeAsync(30000)
    await waitFor(() => value.service.status().error?.code === 'disk_full')
    expect(commands(value, 'stop')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(30000)
    expect(commands(value, 'start')).toHaveLength(1)
  })

  it('開始前檢查停止門檻；statfs 失敗時回報，且不啟動子程序', async () => {
    const value = rig()
    vi.mocked(disk.diskFreeBytes).mockResolvedValue(1024 ** 3)
    value.service.start()
    await waitFor(() => value.service.status().error?.code === 'disk_full')
    expect(commands(value, 'start')).toHaveLength(0)
    vi.mocked(disk.diskFreeBytes).mockRejectedValueOnce(new Error('statfs 失敗'))
    expect(await value.service.startManual()).toBe(false)
    expect(value.service.status().error?.message).toContain('statfs 失敗')
  })

  it('狀態推播合併 250 ms 內的更新，且可解除訂閱', async () => {
    vi.useFakeTimers()
    const value = rig()
    const listener = vi.fn()
    const unsubscribe = value.service.onStatus(listener)
    value.service.setPaused(true); value.service.setPaused(false); value.service.setPaused(true)
    await vi.advanceTimersByTimeAsync(249)
    expect(listener).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(listener).toHaveBeenCalledOnce()
    expect(listener.mock.calls[0][0].paused).toBe(true)
    unsubscribe(); value.service.setPaused(false)
    await vi.advanceTimersByTimeAsync(250)
    expect(listener).toHaveBeenCalledOnce()
  })

  it('能力查詢與錄影分開；找不到 apexrec 時回 null', async () => {
    const value = rig()
    expect((await value.service.capabilities())?.encoders).toContain('hevc_nvenc')
    value.deps.recorderCommand.command = path.join(value.root, 'missing.exe')
    expect(await value.service.capabilities()).toBeNull()
  })

  it('結束服務可取消仍在啟動中的程序，不留下新的錄影', async () => {
    const value = rig('start-stall')
    value.service.start()
    await waitFor(() => commands(value, 'start').length === 1)
    await value.service.stop()
    expect(value.service.status().phase).toBe('idle')
    expect(fs.readdirSync(path.join(value.deps.defaultOutputDir, '.sessions'))).toEqual([])
  })

  it('慢速握手期間遊戲重開只採用最新 PID，不重複結束新工作', async () => {
    const value = rig('slow-hello')
    value.service.start()
    await waitFor(() => commands(value, 'hello').length === 1)
    value.pid = null
    const polls = vi.mocked(value.deps.findApexPid!).mock.calls.length
    await waitFor(() => vi.mocked(value.deps.findApexPid!).mock.calls.length >= polls + 3)
    value.pid = 5678
    await waitFor(() => value.service.status().phase === 'recording')
    expect(commands(value, 'start').map((entry) => entry.pid)).toEqual([5678])
    expect(commands(value, 'stop')).toHaveLength(0)
  })
})

describe.skipIf(!ffmpeg)('錄影服務整合真實收尾', () => {
  let fixtureRoot: string
  let segments: string
  beforeAll(() => { fixtureRoot = tempRoot(); segments = createSegments(fixtureRoot) })
  afterAll(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }))

  it('關閉 Apex 後產生影片、加入媒體庫、排分析並推送完成事件', async () => {
    const value = rig()
    value.settings.postAnalysis = 'afterExit'
    value.deps.ffmpegPath = ffmpeg!
    value.deps.recorderCommand.env!.FAKE_SEGMENT_DIR = segments
    const finalized = vi.fn(); value.service.onFinalized(finalized)
    value.service.start()
    await waitFor(() => value.service.status().phase === 'recording')
    value.pid = null
    await waitFor(() => finalized.mock.calls.length === 1)
    const [output] = finalized.mock.calls[0][0]
    expect(fs.existsSync(output)).toBe(true)
    expect(value.service.status().phase).toBe('idle')
    expect(value.deps.addToLibrary).toHaveBeenCalledWith([output])
    expect(value.deps.enqueueAnalysis).toHaveBeenCalledWith(output)
  })

  it('收尾失敗保留資料夾、error 通知；下次啟動補收尾成功', async () => {
    const value = rig()
    value.deps.recorderCommand.env!.FAKE_SEGMENT_DIR = segments
    value.service.start()
    await waitFor(() => value.service.status().phase === 'recording')
    value.pid = null
    await waitFor(() => value.service.status().error?.code === 'finalize_failed')
    const dir = commands(value, 'start')[0].session_dir
    expect(fs.existsSync(path.join(dir, 'index.jsonl'))).toBe(true)
    expect(value.deps.notify).toHaveBeenCalledWith('error', expect.stringContaining('保留段落'))
    await value.service.stop()
    value.deps.ffmpegPath = ffmpeg!
    value.service = createRecordingService(value.deps)
    const finalized = vi.fn(); value.service.onFinalized(finalized)
    value.service.start()
    await waitFor(() => finalized.mock.calls.length === 1)
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('啟動先補收尾再開始新工作，不會刪除目前錄影', async () => {
    const value = rig()
    value.deps.ffmpegPath = ffmpeg!
    const old = sessionDir(value.root)
    copySegments(segments, old)
    value.service.start()
    await waitFor(() => value.service.status().phase === 'recording')
    expect(fs.existsSync(old)).toBe(false)
    const current = commands(value, 'start')[0].session_dir
    expect(fs.existsSync(current)).toBe(true)
    expect(value.deps.addToLibrary).toHaveBeenCalledOnce()
  })
})
