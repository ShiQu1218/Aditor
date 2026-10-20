import fs from 'fs'
import path from 'path'
import { randomBytes } from 'crypto'
import { EventEmitter } from 'events'
import {
  IDLE_RECORDING_STATUS,
  type LiveState, type LiveUpdate, type RecordingBackend, type RecordingMode, type RecordingService, type RecordingStatus, type RecorderCapabilities, type ObsTestResult
} from '../../shared/recording'
import { isSafeLocalDirPath } from '../safe-path'
import { ApexWatcher, findApexPid } from './apex-watcher'
import { AditorrecClient, RecorderError, type RecorderEvent } from './aditorrec-client'
import { diskFreeBytes, diskLevel } from './disk'
import { MATCH_POST_PAD_SEC, cutMatches, finalizeSession, validateSessionDir, writeJson } from './finalize'
import { recoverSessions } from './recovery'
import { LiveSession } from './live-session'
import { ObsClient } from './obs-client'
import { finalizeObsMatches } from './obs-finalize'
import { ObsRecording } from './obs-session'
import type { RecordingDeps, RecordingNoticeKind } from './index'
import { tr } from '../../shared/locale'

interface ActiveSession {
  pid: number
  id: string
  dir: string
  outputDir: string
  client: AditorrecClient
  ending: boolean
  warned: boolean
  writes: Promise<void>
  sequences: Set<number>
  live: LiveSession
  mode: RecordingMode
  cuts: Promise<void>
  cutPending: boolean
  cutting: boolean
  failedCuts: Set<number>
  backend: RecordingBackend
  obs: ObsRecording | null
  obsFailed?: boolean
  obsEndAt?: number
  obsTimer?: ReturnType<typeof setTimeout>
  obsWork: Promise<void>
  /** aditorrec has reported started (capture has actually begun). */
  captured: boolean
}

/** After stopping our OBS recording, treat active status during this interval as still stopping. */
const OBS_STOP_GRACE_MS = 30_000
/**
 * Delay capture after detecting Apex. During startup the game creates its window, switches to
 * fullscreen, and loads its anti-cheat driver; capturing or creating devices at that point is
 * most likely to trigger driver issues, and the intro does not need to be recorded anyway.
 */
const GAME_START_DELAY_MS = 20_000

function sessionId(): string {
  const date = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${randomBytes(2).toString('hex')}`
}

async function readFrames(profileDir: string): Promise<object> {
  const profile = JSON.parse(await fs.promises.readFile(path.join(profileDir, 'profile.json'), 'utf8'))
  const roi = (value: unknown): value is number[] => Array.isArray(value) && value.length === 4 &&
    value.every((n) => Number.isInteger(n) && n >= 0) && value[2] > 0 && value[3] > 0 &&
    value[0] + value[2] <= 1920 && value[1] + value[3] <= 1080
  if (!roi(profile.banner_roi) || !roi(profile.spec_roi)) throw new RecorderError('profile_invalid', tr('錄影範本的 ROI 無效'))
  return { banner: profile.banner_roi, spec: profile.spec_roi, base: [1920, 1080] }
}

export class RecordingSessionService implements RecordingService {
  private state: RecordingStatus = { ...IDLE_RECORDING_STATUS }
  private events = new EventEmitter()
  private watcher: ApexWatcher
  private running = false
  private gamePid: number | null = null
  private active: ActiveSession | null = null
  private operations: Promise<void> = Promise.resolve()
  private recovery: Promise<void> = Promise.resolve()
  private pollWarning = false
  private blocked = false
  private manualStopped = false
  private restartTimes: number[] = []
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private diskTimer: ReturnType<typeof setInterval> | null = null
  private statusTimer: ReturnType<typeof setTimeout> | null = null
  private capabilityRequests = new Set<AditorrecClient>()
  private pendingObs = new Map<string, ActiveSession>()
  /** Epoch time when this app last stopped an OBS recording (ms). */
  private obsStoppedAt = 0
  private builtinFallbackPid: number | null = null
  /** Time when the current PID was first confirmed. */
  private pidSeenAt = 0
  private startDelayTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private deps: RecordingDeps) {
    this.watcher = new ApexWatcher(deps.findApexPid ?? findApexPid, deps.pollMs ?? 3000,
      (pid) => {
        this.pollWarning = false
        const exited = this.gamePid !== null && pid === null
        if (pid !== this.gamePid) {
          this.manualStopped = false
          this.builtinFallbackPid = null
          this.blocked = false
          this.cancelRetry()
          this.pidSeenAt = Date.now()
          this.log(`apex pid ${pid ?? 'none'}`)
          this.clearStartDelay()
        }
        this.gamePid = pid
        if (exited && this.deps.getSettings().openOnGameExit) this.deps.onGameExit?.()
        void this.serialize(async () => {
          if (!this.running) return
          // Several polls may accumulate while starting or finalizing; use only the latest confirmed PID.
          if (this.active && this.active.pid !== this.gamePid) await this.finish()
          if (this.canAutoStart() && this.gameSettled()) await this.begin(this.gamePid!)
        })
      }, (error) => {
        if (!this.pollWarning) this.notice('error', tr('無法偵測 Apex 程序：{error}', { error: String(error) }))
        this.pollWarning = true
      })
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.recovery = this.serialize(() => recoverSessions(this.deps,
      (paths) => this.finalized(paths),
      (error) => this.fail('recovery_failed', tr('錄影補收尾失敗：{error}', { error: String(error) })),
      () => !this.running))
    this.watcher.start()
  }

  async stop(): Promise<void> {
    this.running = false
    this.watcher.stop()
    this.cancelRetry()
    this.clearStartDelay()
    this.clearDiskTimer()
    // Allow cancellation during startup handshakes so app shutdown does not wait for the full startup timeout.
    if (this.state.phase === 'starting') await this.active?.client.close()
    await Promise.all([...this.capabilityRequests].map((client) => client.close()))
    await this.serialize(() => this.finish())
    for (const session of this.pendingObs.values()) await session.obs?.close()
    this.pendingObs.clear()
    if (this.statusTimer) clearTimeout(this.statusTimer)
    this.statusTimer = null
  }

  async startManual(): Promise<boolean> {
    await this.recovery
    return this.serialize(async () => {
      if (!this.running) return false
      if (this.active) return this.state.phase === 'recording'
      const pid = await (this.deps.findApexPid ?? findApexPid)()
      if (!pid || !this.running) return false
      if (pid !== this.gamePid) {
        this.builtinFallbackPid = null
      }
      this.gamePid = pid
      this.manualStopped = false
      this.blocked = false
      this.cancelRetry()
      return this.begin(pid)
    })
  }

  async stopManual(): Promise<void> {
    this.manualStopped = true
    this.cancelRetry()
    if (this.state.phase === 'starting') await this.active?.client.close()
    await this.serialize(() => this.finish())
  }

  setPaused(paused: boolean): void {
    this.update({ paused })
    if (paused) this.cancelRetry()
    else void this.serialize(async () => {
      if (this.canAutoStart() && this.gameSettled()) await this.begin(this.gamePid!)
    })
  }

  status(): RecordingStatus {
    return Object.freeze({ ...this.state, error: this.state.error ? Object.freeze({ ...this.state.error }) : null })
  }

  async capabilities(): Promise<RecorderCapabilities | null> {
    const client = new AditorrecClient(this.deps.recorderCommand)
    this.capabilityRequests.add(client)
    try { return await client.hello() }
    catch { return null }
    finally {
      await client.close()
      this.capabilityRequests.delete(client)
    }
  }

  async testObs(): Promise<ObsTestResult> {
    const client = new ObsClient()
    const settings = this.deps.getSettings()
    try {
      await client.connect(settings.obsHost, settings.obsPort, this.deps.getObsPassword?.())
      return { ok: true, ...await client.version() }
    } catch (error) { return { ok: false, error: (error as Error).message } }
    finally { await client.close() }
  }

  onStatus(listener: (s: RecordingStatus) => void): () => void {
    this.events.on('status', listener)
    return () => { this.events.off('status', listener) }
  }

  onFinalized(listener: (paths: string[]) => void): () => void {
    this.events.on('finalized', listener)
    return () => { this.events.off('finalized', listener) }
  }

  async live(): Promise<LiveState | null> {
    return this.active ? this.active.live.state() : null
  }

  async readInit(sessionId: string): Promise<Uint8Array> {
    return this.liveFor(sessionId).readInit()
  }

  async readSegment(sessionId: string, seq: number): Promise<Uint8Array> {
    return this.liveFor(sessionId).readSegment(seq)
  }

  onLive(listener: (update: LiveUpdate) => void): () => void {
    this.events.on('live', listener)
    return () => { this.events.off('live', listener) }
  }

  /** Allow only the current recording session, including finalization while its directory still exists. */
  private liveFor(sessionId: string): LiveSession {
    if (!this.active || this.active.id !== sessionId) throw new Error(tr('錄影工作不存在或已收尾'))
    return this.active.live
  }

  private createLive(id: string, dir: string): LiveSession {
    const live = new LiveSession({
      sessionId: id, dir, command: this.deps.liveEngineCommand, profileDir: this.deps.profileDir,
      sceneDir: this.deps.sceneDir, restartBaseMs: this.deps.liveRestartBaseMs,
      recordEvent: (event) => { if (this.active?.live === live) this.recordEvent(this.active, event) },
      notice: (message) => this.notice('error', message)
    })
    live.on('update', (update: LiveUpdate) => { if (this.active?.live === live) this.events.emit('live', update) })
    live.on('stats', () => {
      if (this.active?.live === live) this.update({ kills: live.kills(), matchIndex: live.matchIndex() })
    })
    live.on('match', (ev: 'match_start' | 'match_end' | 'match_pending' | 'match_cancel', index: number, time: number) => {
      if (this.active?.live !== live) return
      if (ev === 'match_start') this.notice('matchStart', tr('第 {index} 局開始', { index }))
      else if (ev === 'match_end') this.notice('matchEnd', tr('第 {index} 局結束（計入擊殺 {kills}）', { index, kills: live.kills() }))
      const session = this.active
      if (session.obs?.perMatch && !session.ending && !session.obsFailed) {
        if (session.obsTimer) clearTimeout(session.obsTimer)
        session.obsTimer = undefined
        if (ev === 'match_start' || ev === 'match_pending') {
          session.obsEndAt = undefined
          this.queueObs(session, async () => {
            if (session.obsFailed) return
            const current = session.obs!.matches.at(-1)
            if (ev === 'match_start' && current?.confirmed === false && !current.cancelled && session.obs!.recording) {
              current.confirmed = true
              await session.obs!.save()
              return
            }
            await this.stopObsMatch(session)
            try { await session.obs!.startMatch(index, ev === 'match_start'); this.update({ obsRecording: true }) }
            catch (error) {
              session.obsFailed = true
              this.notice('warning', tr('OBS 無法開始逐局錄影：{error}', { error: String(error) }))
              // Recreate the capture session so the built-in encoder starts on a new timeline.
              const fallback = this.deps.getSettings().obsFallbackBuiltin
              if (fallback) {
                this.builtinFallbackPid = session.pid
                void this.serialize(async () => {
                  if (await this.finish() && this.running && this.gamePid && !this.manualStopped && !this.state.paused) {
                    await this.begin(this.gamePid, true)
                  }
                })
              } else {
                await session.obs!.close()
                session.obs = null
                this.update({ obsRecording: false, detectionOnly: true })
              }
            }
          })
        } else if (ev === 'match_cancel') {
          session.obsEndAt = undefined
          this.queueObs(session, async () => {
            if (session.obsFailed || !session.obs) return
            const current = session.obs.matches.at(-1)
            if (!current || current.confirmed !== false || current.cancelled) return
            current.cancelled = true
            await session.obs!.save()
            await this.stopObsMatch(session)
            this.notice('matchCancel', tr('倒數後未開局，已停止 OBS 錄影（檔案保留於 OBS 資料夾）'))
          })
        } else {
          const delay = Math.max(0, session.obs.meta.captureStartedAt + time * 1000 + (this.deps.obsMatchPostPadMs ?? MATCH_POST_PAD_SEC * 1000) - Date.now())
          session.obsEndAt = Date.now() + delay
          session.obsTimer = setTimeout(() => {
            session.obsTimer = undefined
            this.queueObs(session, () => this.stopObsMatch(session))
          }, delay)
        }
      }
      if (ev === 'match_start' || ev === 'match_end') this.scheduleCuts(session)
    })
    return live
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.operations.then(action)
    this.operations = result.then(() => {}, (error) => this.fail('internal', String(error)))
    return result
  }

  /** Schedule one recheck and return false when the game has not yet completed its startup delay. */
  private gameSettled(): boolean {
    const remaining = this.pidSeenAt + (this.deps.gameStartDelayMs ?? GAME_START_DELAY_MS) - Date.now()
    if (remaining <= 0) return true
    if (!this.startDelayTimer) {
      this.startDelayTimer = setTimeout(() => {
        this.startDelayTimer = null
        void this.serialize(async () => {
          if (this.canAutoStart() && this.gameSettled()) await this.begin(this.gamePid!)
        })
      }, remaining)
      this.startDelayTimer.unref()
    }
    return false
  }

  private clearStartDelay(): void {
    if (this.startDelayTimer) clearTimeout(this.startDelayTimer)
    this.startDelayTimer = null
  }

  private canAutoStart(): boolean {
    return this.running && this.gamePid !== null && !this.active && !this.state.paused &&
      !this.manualStopped && !this.blocked && !this.retryTimer && this.deps.getSettings().autoRecord
  }

  private async begin(pid: number, builtin = false): Promise<boolean> {
    const settings = { ...this.deps.getSettings() }
    if (builtin || this.builtinFallbackPid === pid) settings.backend = 'builtin'
    const capture = settings.backend === 'obs' ? 'dda' : settings.captureMethod
    this.log(`begin pid=${pid} backend=${settings.backend} capture=${capture}`)
    const outputDir = settings.outputDir ?? this.deps.getWatchFolders()[0] ?? this.deps.defaultOutputDir
    this.update({ ...IDLE_RECORDING_STATUS, paused: this.state.paused, phase: 'starting' })
    let session: ActiveSession | null = null
    try {
      if (!isSafeLocalDirPath(outputDir)) throw new RecorderError('output_invalid', tr('錄影資料夾必須是本機絕對路徑'))
      await fs.promises.mkdir(outputDir, { recursive: true })
      const free = await diskFreeBytes(outputDir)
      this.update({ diskFreeBytes: free })
      if (diskLevel(free, settings) === 'stop') throw new RecorderError('disk_full', tr('磁碟剩餘空間低於停止門檻，無法開始錄影'))
      const frames = await readFrames(this.deps.profileDir)
      const id = sessionId()
      const root = path.join(outputDir, '.sessions')
      await fs.promises.mkdir(root, { recursive: true })
      if ((await fs.promises.lstat(root)).isSymbolicLink()) throw new RecorderError('output_invalid', tr('錄影工作目錄不可使用連結'))
      const dir = path.join(root, id)
      await fs.promises.mkdir(dir)
      await validateSessionDir(dir)
      const startedAt = Date.now()
      const writeSnapshot = (): Promise<void> => writeJson(path.join(dir, 'recording.json'), {
        startedAt, postAnalysis: settings.postAnalysis, mode: settings.mode, backend: session?.backend ?? settings.backend
      })
      await writeSnapshot()
      const client = new AditorrecClient(this.deps.recorderCommand)
      const live = this.createLive(id, dir)
      session = { pid, id, dir, outputDir, client, ending: false, warned: false, writes: Promise.resolve(), sequences: new Set(), live,
        mode: settings.mode, cuts: Promise.resolve(), cutPending: false, cutting: false, failedCuts: new Set(), backend: settings.backend, obs: null, obsWork: Promise.resolve(), captured: false }
      this.active = session
      this.update({ sessionId: id, startedAt, backend: settings.backend })
      const current = session
      client.on('event', (event: RecorderEvent) => this.onEvent(current, event))
      client.on('crash', (error: Error) => {
        if (this.active === current && !current.ending) void this.serialize(() => this.crashed(current, error))
      })
      if (settings.backend === 'obs') {
        try {
          // Use the same fallback for decryption and connection errors; never include the password in the settings snapshot.
          const password = this.deps.getObsPassword?.()
          current.obs = new ObsRecording(dir, settings, password, (message) => this.notice('warning', message), this.deps.obsReconnectBaseMs)
          await current.obs.start(this.obsStoppedAt + (this.deps.obsStopGraceMs ?? OBS_STOP_GRACE_MS))
          this.update({ obsRecording: current.obs.recording })
          current.obs.on('stopped', () => {
            if (this.active === current && !current.ending) this.update(current.obs?.perMatch ? { obsRecording: false } : { detectionOnly: true })
            if (current.obs?.perMatch && !current.ending) this.queueObs(current, () => this.completeObsMatches(current))
            if (this.pendingObs.has(current.id)) void this.serialize(() => this.finishPendingObs(current))
            else if (this.active === current && !current.ending && current.obs?.meta.adopted && current.obs.meta.outputPath) {
              this.manualStopped = true
              void this.serialize(() => this.finish())
            }
          })
        } catch (error) {
          await current.obs?.close()
          current.obs = null
          this.notice('warning', tr('{message}；{fallback}', { message: (error as Error).message, fallback: settings.obsFallbackBuiltin ? tr('本次改用內建錄影器') : tr('本次僅執行即時偵測') }))
          if (settings.obsFallbackBuiltin) current.backend = 'builtin'
          else await writeJson(path.join(dir, 'obs.json'), { recordStartedAt: startedAt, captureStartedAt: startedAt, adopted: false })
          this.update({ backend: current.backend, detectionOnly: !settings.obsFallbackBuiltin })
          await writeSnapshot()
        }
      }
      await client.hello()
      if (!this.running || this.manualStopped || this.gamePid !== pid) throw new RecorderError('cancelled', tr('錄影啟動已取消'))
      await client.startRecording({ pid, session_dir: dir, session_id: id,
        encode: current.backend === 'obs' ? null : { codec: settings.codec, encoder: settings.encoder, fps: settings.fps, height: settings.height, bitrate_kbps: settings.bitrateKbps,
          preset: settings.preset, aspect: settings.forceAspect ? settings.aspectMode : 'native' },
        audio: current.backend === 'obs' ? null : { render: settings.renderDevice, capture: settings.captureDevice, mic_gain: settings.micGain, mic_enabled: settings.micEnabled,
          render_enabled: settings.systemAudioEnabled, render_gain: settings.systemGain, render_source: settings.gameAudioOnly ? 'game' : 'device',
          mic_mono: settings.micMono }, frames,
        capture })
      await current.writes
      if (this.active !== current || current.ending) return false
      await this.checkDisk(current)
      if (!current.ending) {
        this.diskTimer = setInterval(() => {
          void this.serialize(() => this.checkDisk(current))
        }, 30000)
        this.diskTimer.unref()
      }
      return this.state.phase === 'recording'
    } catch (error) {
      if (session && this.active === session) {
        session.ending = true
        await session.client.close()
        await session.live.stop()
        if (!await this.finish()) return false
      }
      const code = error instanceof RecorderError ? error.code : 'recording_start_failed'
      if (!this.running || this.manualStopped || code === 'cancelled') { this.idle(); return false }
      this.fail(code, tr('無法開始錄影：{error}', { error: String(error) }))
      if (code === 'no_hw_encoder' || code === 'disk_full' || code === 'profile_invalid' || code === 'output_invalid') this.blocked = true
      else this.scheduleRestart()
      return false
    }
  }

  private onEvent(session: ActiveSession, event: RecorderEvent): void {
    if (this.active !== session) return
    switch (event.ev) {
      case 'started':
        if (session.ending) return
        if ((session.backend !== 'obs' && typeof event.encoder !== 'string') || !Number.isSafeInteger(event.width) || Number(event.width) <= 0 ||
            !Number.isSafeInteger(event.height) || Number(event.height) <= 0) return
        this.log(`capture started ${String(event.width)}x${String(event.height)} encoder=${String(event.encoder ?? 'none')}`)
        this.update({ phase: 'recording', encoder: typeof event.encoder === 'string' ? event.encoder : null, width: Number(event.width), height: Number(event.height), error: null })
        session.captured = true
        if (session.obs) {
          const now = Date.now()
          session.writes = session.writes.then(() => session.obs!.captureStarted(now))
          void session.writes.catch(() => {})
        }
        if (typeof event.shm === 'string' && event.shm.length > 0 && event.shm.length <= 256) {
          session.live.startEngine(event.shm, Number(event.width), Number(event.height))
        }
        break
      case 'segment':
        if (typeof event.seq === 'number' && Number.isSafeInteger(event.seq) && event.seq > 0 &&
            typeof event.pts === 'number' && Number.isFinite(event.pts) && event.pts >= 0 &&
            typeof event.dur === 'number' && Number.isFinite(event.dur) && event.dur > 0) {
          session.sequences.add(event.seq)
          session.live.addSegment({ seq: event.seq, pts: event.pts, dur: event.dur })
          this.scheduleCuts(session)
          // Segments update only the snapshot; publish with five-second stats or phase changes to avoid one IPC per segment.
          this.update({ segments: session.sequences.size, durationSec: Math.max(this.state.durationSec, event.pts + event.dur) }, false)
        }
        break
      case 'stats':
        if (session.backend === 'obs' && this.state.startedAt) this.update({ durationSec: (Date.now() - this.state.startedAt) / 1000 }, false)
        if (typeof event.dropped === 'number' && Number.isSafeInteger(event.dropped) && event.dropped >= 0) this.update({ droppedFrames: event.dropped })
        break
      case 'window_lost':
      case 'window_found':
        this.recordEvent(session, event)
        break
      case 'error':
        if (!session.ending) {
          const error = new RecorderError(String(event.code), String(event.message))
          void this.serialize(() => this.crashed(session, error))
        }
        break
      case 'warning':
        if (!session.ending && typeof event.message === 'string') this.notice('warning', event.message)
        break
      case 'stopped':
        if (!session.ending) void this.serialize(() => this.crashed(session,
          new RecorderError('recorder_stopped', tr('錄影意外停止：{reason}', { reason: String(event.reason) }))))
        break
    }
  }

  /** Separate from the recording control queue; coalesce notices during clipping and wait for the current clip before finalizing on stop. */
  private scheduleCuts(session: ActiveSession): void {
    if (session.backend === 'obs' || session.mode !== 'match' || session.ending) return
    session.cutPending = true
    if (session.cutting) return
    session.cutting = true
    const onError = (error: unknown): void => {
      this.notice('error', tr('逐局剪檔失敗，錄影繼續，收尾時將重試：{error}', { error: String(error) }))
    }
    session.cuts = (async () => {
      while (session.cutPending && !session.ending) {
        session.cutPending = false
        await session.live.flush()
        await session.live.prune()
        await cutMatches(session.dir, this.deps, {
          failed: session.failedCuts, onCut: (outputPath) => this.finalized([outputPath]), onError
        })
      }
    })().catch(onError).finally(() => { session.cutting = false })
  }

  private queueObs(session: ActiveSession, action: () => Promise<void>): void {
    session.obsWork = session.obsWork.then(action).catch((error) => {
      this.notice('error', tr('OBS 逐局錄影處理失敗，已保留工作：{error}', { error: String(error) }))
    })
  }

  private async stopObsMatch(session: ActiveSession): Promise<void> {
    const obs = session.obs
    if (!obs?.perMatch || !obs.recording) return
    const current = obs.matches.at(-1)
    if (current?.confirmed === false) { current.cancelled = true; await obs.save() }
    if (!await obs.stop()) throw new Error(tr('OBS 尚未停止錄影'))
    this.update({ obsRecording: false })
    await this.completeObsMatches(session)
  }

  private async completeObsMatches(session: ActiveSession): Promise<void> {
    const obs = session.obs
    if (!obs?.perMatch) return
    await session.live.flush()
    const config = JSON.parse(await fs.promises.readFile(path.join(session.dir, 'recording.json'), 'utf8'))
    session.cuts = session.cuts.then(async () => {
      const paths = await finalizeObsMatches(session.dir, this.deps, config, obs.matches, false, () => obs.save(), obs.meta)
      if (paths.length) this.finalized(paths)
    }).catch((error) => this.notice('error', tr('OBS 逐局影片入庫失敗，收尾時將重試：{error}', { error: String(error) })))
  }

  private async crashed(session: ActiveSession, error: Error): Promise<void> {
    if (this.active !== session || session.ending) return
    this.recordEvent(session, { ev: 'gap', pts: this.state.durationSec, message: error.message })
    const finalized = await this.finish()
    const code = error instanceof RecorderError ? error.code : 'recorder_crashed'
    if (!finalized) return
    if (!this.running) return
    this.fail(code, error.message)
    if (code === 'no_hw_encoder') this.blocked = true
    else this.scheduleRestart()
  }

  private scheduleRestart(): void {
    if (!this.running || !this.gamePid || this.state.paused || this.manualStopped) return
    const now = Date.now()
    this.restartTimes = this.restartTimes.filter((time) => now - time < 600000)
    if (this.restartTimes.length >= 5) {
      this.blocked = true
      this.fail('restart_limit', tr('錄影程序在 10 分鐘內已重啟 5 次，已停止重試'))
      return
    }
    const delay = 1000 * 2 ** this.restartTimes.length
    this.restartTimes.push(now)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.serialize(async () => {
        if (this.running && this.gamePid && !this.state.paused && !this.manualStopped && !this.blocked) await this.begin(this.gamePid)
      })
    }, delay)
    this.retryTimer.unref()
  }

  private async checkDisk(session: ActiveSession): Promise<void> {
    if (this.active !== session || session.ending) return
    try {
      const bytes = await diskFreeBytes(session.outputDir)
      this.update({ diskFreeBytes: bytes })
      const level = diskLevel(bytes, this.deps.getSettings())
      if (level === 'stop') {
        this.blocked = true
        if (await this.finish()) this.fail('disk_full', tr('磁碟剩餘空間低於停止門檻，已停止錄影並收尾'))
      } else if (level === 'warn' && !session.warned) {
        session.warned = true
        this.notice('diskWarn', tr('錄影磁碟剩餘 {gb} GB', { gb: (bytes / 1024 ** 3).toFixed(1) }))
      }
    } catch (error) {
      this.blocked = true
      if (await this.finish()) this.fail('disk_check_failed', tr('無法檢查錄影磁碟，已停止錄影：{error}', { error: String(error) }))
    }
  }

  private async finish(): Promise<boolean> {
    if (this.active) this.log(`finish session=${this.active.id}`)
    const session = this.active
    if (!session) return true
    session.ending = true
    if (session.obsTimer) clearTimeout(session.obsTimer)
    await session.obsWork
    this.clearDiskTimer()
    try { await session.client.stop() }
    catch (error) { this.notice('error', tr('錄影程序停止失敗，將收尾已完成段落：{error}', { error: String(error) })) }
    this.update({ phase: 'finalizing' })
    // Wait for the live engine's final snapshot to be written to live.json before converting it into an analysis cache.
    await session.live.stop()
    try {
      await session.writes
      await session.cuts
      if (session.obs && !session.captured) {
        // Capture never started (for example, the game was closing), so there are no aligned detection results.
        // Leave reused recordings alone; stop recordings started by this app without adding an almost-empty OBS file to the library.
        if (!session.obs.meta.adopted) {
          await session.obs.stop()
          this.obsStoppedAt = Date.now()
        }
        await session.obs.close()
        await fs.promises.rm(session.dir, { recursive: true, force: true })
        this.active = null
        this.idle()
        return true
      }
      if (session.obs?.perMatch && session.obs.recording) {
        const deadline = session.obs.matches.at(-1)?.confirmed === false ? Date.now()
          : session.obsEndAt ?? Date.now() + (this.deps.obsMatchPostPadMs ?? MATCH_POST_PAD_SEC * 1000)
        const delay = Math.max(0, deadline - Date.now())
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
        await this.stopObsMatch(session)
        await session.cuts
      }
      if (session.obs) {
        const ready = await session.obs.stop()
        if (!session.obs.meta.adopted) this.obsStoppedAt = Date.now()
        if (!ready && session.obs.perMatch) throw new Error(tr('OBS 逐局錄影尚未停止，已保留工作'))
        if (!ready) {
          this.pendingObs.set(session.id, session)
          this.active = null
          this.idle()
          return true
        }
        await session.obs.close()
      }
      const paths = await finalizeSession(session.dir, this.deps)
      this.active = null
      this.idle()
      this.events.emit('live', { sessionId: session.id, finalized: [...paths] } satisfies LiveUpdate)
      if (paths.length) this.finalized(paths)
      return true
    } catch (error) {
      // Disconnect OBS and stop recordings started by this app even if event writing or clipping fails.
      try { await session.obs?.stop(); await session.obs?.close() }
      catch { this.notice('warning', tr('OBS 收尾連線未完成，請在 OBS 確認錄影狀態')) }
      this.active = null
      this.blocked = true
      this.fail('finalize_failed', tr('錄影收尾失敗，已保留段落供下次重試：{error}', { error: String(error) }))
      return false
    }
  }

  private async finishPendingObs(session: ActiveSession): Promise<void> {
    if (!this.pendingObs.delete(session.id)) return
    try {
      await session.obs?.close()
      const paths = await finalizeSession(session.dir, this.deps)
      this.events.emit('live', { sessionId: session.id, finalized: [...paths] } satisfies LiveUpdate)
      if (paths.length) this.finalized(paths)
    } catch (error) { this.notice('error', tr('OBS 錄影收尾失敗，已保留工作供下次重試：{error}', { error: String(error) })) }
  }

  private recordEvent(session: ActiveSession, event: RecorderEvent): void {
    session.writes = session.writes.then(() => fs.promises.appendFile(path.join(session.dir, 'events.jsonl'),
      JSON.stringify({ ...event, wall: new Date().toISOString() }) + '\n'))
    // Attach a rejection handler immediately; finish still checks the original promise and preserves the session directory.
    void session.writes.catch(() => {})
  }

  private finalized(paths: string[]): void {
    this.events.emit('finalized', [...paths])
    this.notice('finalized', tr('已儲存：{paths}', { paths: paths.map((p) => path.basename(p)).join('、') }))
  }

  private update(patch: Partial<RecordingStatus>, publish = true): void {
    this.state = { ...this.state, ...patch }
    if (!publish) return
    if (!this.statusTimer) {
      this.statusTimer = setTimeout(() => {
        this.statusTimer = null
        this.events.emit('status', this.status())
      }, 250)
      this.statusTimer.unref()
    }
  }

  private idle(): void { this.update({ ...IDLE_RECORDING_STATUS, paused: this.state.paused }) }
  private fail(code: string, message: string): void {
    this.update({ phase: 'error', error: { code, message } })
    this.notice('error', message)
  }
  private notice(kind: RecordingNoticeKind, message: string): void {
    this.log(`notice ${kind}: ${message}`)
    this.deps.notify(kind, message)
  }
  private log(message: string): void {
    try { this.deps.log?.(message) } catch { /* A diagnostic logging failure must not affect recording. */ }
  }
  private cancelRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }
  private clearDiskTimer(): void {
    if (this.diskTimer) clearInterval(this.diskTimer)
    this.diskTimer = null
  }
}
