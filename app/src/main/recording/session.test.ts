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

describe('recording service state machine', () => {
  it.each([['cloud', '雲端同步'], ['network', '網路磁碟']] as const)('warns once per output folder when recording to %s storage', async (kind, text) => {
    const value = rig()
    value.deps.probeStorage = vi.fn(async () => kind)
    value.service.start()
    await waitFor(() => vi.mocked(value.deps.notify).mock.calls.some(([level, message]) => level === 'warning' && message.includes(text)))
    await waitFor(() => value.service.status().segments === 2)
    value.pid = null
    await waitFor(() => value.service.status().phase === 'idle')
    value.pid = 5678
    await waitFor(() => commands(value, 'start').length === 2)
    expect(value.deps.probeStorage).toHaveBeenCalledOnce()
    expect(vi.mocked(value.deps.notify).mock.calls.filter(([, message]) => message.includes(text))).toHaveLength(1)
  })

  it('keeps recording when the storage probe fails', async () => {
    const value = rig()
    value.deps.probeStorage = vi.fn(async () => { throw new Error('probe failed') })
    value.service.start()
    await waitFor(() => value.service.status().segments === 2)
    expect(value.service.status().phase).toBe('recording')
  })

  it('automatically starts and stops, passes ROI and media settings, tracks segments and dropped frames, and returns immutable snapshots', async () => {
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

  it.each(['fit', 'stretch'] as const)('Pass all new video settings to start: %s', async (aspectMode) => {
    const value = rig()
    Object.assign(value.settings, { fps: 20, preset: 'quality', forceAspect: true, aspectMode,
      systemAudioEnabled: false, systemGain: 0.35, gameAudioOnly: true, micMono: true })
    value.service.start()
    await waitFor(() => value.service.status().phase === 'recording')
    const [start] = commands(value, 'start')
    expect(start.encode).toMatchObject({ fps: 20, preset: 'quality', aspect: aspectMode })
    expect(start.audio).toMatchObject({ render_enabled: false, render_gain: 0.35, render_source: 'game', mic_mono: true })
  })

  it('shows recorder warnings as non-fatal notices and continues recording without a restart', async () => {
    const value = rig('warning')
    value.service.start()
    await waitFor(() => vi.mocked(value.deps.notify).mock.calls.some(([kind]) => kind === 'warning'))
    expect(value.service.status()).toMatchObject({ phase: 'recording', error: null })
    expect(commands(value, 'start')).toHaveLength(1)
    expect(commands(value, 'stop')).toHaveLength(0)
  })

  it('defaults to wgc and uses dda after changing the capture setting', async () => {
    const value = rig()
    value.service.start()
    await waitFor(() => value.service.status().phase === 'recording')
    expect(commands(value, 'start')[0].capture).toBe('wgc')
    await value.service.stopManual()
    value.settings.captureMethod = 'dda'
    expect(await value.service.startManual()).toBe(true)
    expect(commands(value, 'start')[1].capture).toBe('dda')
  })

  it('waits for Apex startup to stabilize before capture when the game launches while Aditor runs', async () => {
    const value = rig()
    value.deps.gameStartDelayMs = 400
    value.service = createRecordingService(value.deps)
    value.pid = null
    value.service.start()
    await waitFor(() => vi.mocked(value.deps.findApexPid!).mock.calls.length >= 2)
    value.pid = 1234
    const launchedAt = Date.now()
    await waitFor(() => commands(value, 'start').length > 0, 5000)
    expect(Date.now() - launchedAt).toBeGreaterThanOrEqual(400)
  })
  it('starts without the startup delay when Apex is already running when Aditor starts', async () => {
    const value = rig()
    value.deps.gameStartDelayMs = 5000
    value.service = createRecordingService(value.deps)
    const startedAt = Date.now()
    value.service.start()
    await waitFor(() => commands(value, 'start').length > 0, 4000)
    expect(Date.now() - startedAt).toBeLessThan(4000)
  })
  it('logs why auto-start is skipped once per reason', async () => {
    const value = rig()
    const log = vi.fn()
    value.deps.log = log
    value.settings.autoRecord = false
    value.service = createRecordingService(value.deps)
    value.service.start()
    await waitFor(() => vi.mocked(value.deps.findApexPid!).mock.calls.length >= 4)
    expect(log.mock.calls.filter(([line]) => line === 'auto-start skipped: auto record disabled')).toHaveLength(1)
    value.service.setPaused(true)
    value.settings.autoRecord = true
    await waitFor(() => log.mock.calls.some(([line]) => line === 'auto-start skipped: paused'))
    value.service.setPaused(false)
    await waitFor(() => value.service.status().phase === 'recording')
  })
  it('recalculates the startup delay after the game restarts with a new PID', async () => {
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
  it('pause prevents automatic recording until resumed, and manual stop does not restart on the next poll', async () => {
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

  it('manual start ignores autoRecord and pause settings and returns false when Apex is not running', async () => {
    const value = rig(); value.settings.autoRecord = false; value.pid = null
    value.service.start(); value.service.setPaused(true)
    expect(await value.service.startManual()).toBe(false)
    value.pid = 1234
    expect(await value.service.startManual()).toBe(true)
    expect(value.service.status()).toMatchObject({ phase: 'recording', paused: true })
    await value.service.stopManual()
  })

  it('applies autoRecord setting changes without a restart and selects the output folder from the watched folder', async () => {
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

  it.each(['no-hw', 'async-no-hw'])('Without a hardware encoder, fail immediately without retrying: %s', async (mode) => {
    const value = rig(mode)
    value.service.start()
    await waitFor(() => value.service.status().error?.code === 'no_hw_encoder')
    const polls = vi.mocked(value.deps.findApexPid!).mock.calls.length
    await waitFor(() => vi.mocked(value.deps.findApexPid!).mock.calls.length >= polls + 3)
    expect(commands(value, 'start')).toHaveLength(1)
    expect(value.deps.notify).toHaveBeenCalledWith('error', expect.stringContaining('硬體編碼器'))
    expect(Object.isFrozen(value.service.status().error)).toBe(true)
  })

  it('uses 1/2/4/8/16-second crash backoff and allows at most 5 restarts within 10 minutes', async () => {
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

  it('warns about disk space once and stops below the threshold without restarting automatically', async () => {
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

  it('checks the stop threshold before starting and reports statfs failures without launching the child process', async () => {
    const value = rig()
    vi.mocked(disk.diskFreeBytes).mockResolvedValue(1024 ** 3)
    value.service.start()
    await waitFor(() => value.service.status().error?.code === 'disk_full')
    expect(commands(value, 'start')).toHaveLength(0)
    vi.mocked(disk.diskFreeBytes).mockRejectedValueOnce(new Error('statfs 失敗'))
    expect(await value.service.startManual()).toBe(false)
    expect(value.service.status().error?.message).toContain('statfs 失敗')
  })

  it('coalesces status updates within 250 ms and supports unsubscribing', async () => {
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

  it('keeps capability checks separate from recording and returns null when aditorrec is missing', async () => {
    const value = rig()
    expect((await value.service.capabilities())?.encoders).toContain('hevc_nvenc')
    value.deps.recorderCommand.command = path.join(value.root, 'missing.exe')
    expect(await value.service.capabilities()).toBeNull()
  })

  it('service shutdown cancels a process that is still starting and does not leave a new recording behind', async () => {
    const value = rig('start-stall')
    value.service.start()
    await waitFor(() => commands(value, 'start').length === 1)
    await value.service.stop()
    expect(value.service.status().phase).toBe('idle')
    expect(fs.readdirSync(path.join(value.deps.defaultOutputDir, '.sessions'))).toEqual([])
  })

  it('uses only the latest PID when the game restarts during a slow handshake and does not finish the new session twice', async () => {
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

  it('calls onGameExit once when Apex exits (non-null PID to null) with openOnGameExit enabled, but not when disabled, initially absent, or replaced by another PID', async () => {
    const value = rig()
    const onGameExit = vi.fn()
    value.deps.onGameExit = onGameExit
    value.settings.autoRecord = false
    value.pid = null
    value.service.start()
    await waitFor(() => vi.mocked(value.deps.findApexPid!).mock.calls.length >= 3)
    expect(onGameExit).not.toHaveBeenCalled()

    value.pid = 1234
    let polls = vi.mocked(value.deps.findApexPid!).mock.calls.length
    await waitFor(() => vi.mocked(value.deps.findApexPid!).mock.calls.length >= polls + 3)
    value.pid = 5678
    polls = vi.mocked(value.deps.findApexPid!).mock.calls.length
    await waitFor(() => vi.mocked(value.deps.findApexPid!).mock.calls.length >= polls + 3)
    expect(onGameExit).not.toHaveBeenCalled()

    value.pid = null
    polls = vi.mocked(value.deps.findApexPid!).mock.calls.length
    await waitFor(() => vi.mocked(value.deps.findApexPid!).mock.calls.length >= polls + 4)
    expect(onGameExit).toHaveBeenCalledTimes(1)

    value.settings.openOnGameExit = false
    value.pid = 9999
    polls = vi.mocked(value.deps.findApexPid!).mock.calls.length
    await waitFor(() => vi.mocked(value.deps.findApexPid!).mock.calls.length >= polls + 3)
    value.pid = null
    polls = vi.mocked(value.deps.findApexPid!).mock.calls.length
    await waitFor(() => vi.mocked(value.deps.findApexPid!).mock.calls.length >= polls + 3)
    expect(onGameExit).toHaveBeenCalledTimes(1)
  })
})

describe.skipIf(!ffmpeg)('recording service integration with real finalization', () => {
  let fixtureRoot: string
  let segments: string
  beforeAll(() => { fixtureRoot = tempRoot(); segments = createSegments(fixtureRoot) })
  afterAll(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }))

  it('produces a video after Apex exits, adds it to the library, queues analysis, and publishes a completion event', async () => {
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

  it('preserves the directory and reports an error when finalization fails, then recovers successfully on the next startup', async () => {
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

  it('recovers previous sessions before starting a new one and does not delete the active recording', async () => {
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
