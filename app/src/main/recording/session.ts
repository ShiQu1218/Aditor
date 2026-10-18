import fs from 'fs'
import path from 'path'
import { randomBytes } from 'crypto'
import { EventEmitter } from 'events'
import {
  IDLE_RECORDING_STATUS,
  type LiveState, type LiveUpdate, type RecordingService, type RecordingStatus, type RecorderCapabilities
} from '../../shared/recording'
import { isSafeLocalDirPath } from '../safe-path'
import { ApexWatcher, findApexPid } from './apex-watcher'
import { ApexrecClient, RecorderError, type RecorderEvent } from './apexrec-client'
import { diskFreeBytes, diskLevel } from './disk'
import { finalizeSession, validateSessionDir, writeJson } from './finalize'
import { recoverSessions } from './recovery'
import { LiveSession } from './live-session'
import type { RecordingDeps, RecordingNoticeKind } from './index'

interface ActiveSession {
  pid: number
  id: string
  dir: string
  outputDir: string
  client: ApexrecClient
  ending: boolean
  warned: boolean
  writes: Promise<void>
  sequences: Set<number>
  live: LiveSession
}

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
  if (!roi(profile.banner_roi) || !roi(profile.spec_roi)) throw new RecorderError('profile_invalid', '錄影範本的 ROI 無效')
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
  private capabilityRequests = new Set<ApexrecClient>()

  constructor(private deps: RecordingDeps) {
    this.watcher = new ApexWatcher(deps.findApexPid ?? findApexPid, deps.pollMs ?? 3000,
      (pid) => {
        this.pollWarning = false
        if (pid !== this.gamePid) {
          this.manualStopped = false
          this.blocked = false
          this.cancelRetry()
        }
        this.gamePid = pid
        void this.serialize(async () => {
          if (!this.running) return
          // 等候啟動或收尾期間可能已累積多次輪詢，只採用最新確認的 PID。
          if (this.active && this.active.pid !== this.gamePid) await this.finish()
          if (this.canAutoStart()) await this.begin(this.gamePid!)
        })
      }, (error) => {
        if (!this.pollWarning) this.notice('error', `無法偵測 Apex 程序：${String(error)}`)
        this.pollWarning = true
      })
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.recovery = this.serialize(() => recoverSessions(this.deps,
      (paths) => this.finalized(paths),
      (error) => this.fail('recovery_failed', `錄影補收尾失敗：${String(error)}`),
      () => !this.running))
    this.watcher.start()
  }

  async stop(): Promise<void> {
    this.running = false
    this.watcher.stop()
    this.cancelRetry()
    this.clearDiskTimer()
    // 啟動中也能取消握手，不讓結束 App 等候完整的啟動逾時。
    if (this.state.phase === 'starting') await this.active?.client.close()
    await Promise.all([...this.capabilityRequests].map((client) => client.close()))
    await this.serialize(() => this.finish())
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
      if (this.canAutoStart()) await this.begin(this.gamePid!)
    })
  }

  status(): RecordingStatus {
    return Object.freeze({ ...this.state, error: this.state.error ? Object.freeze({ ...this.state.error }) : null })
  }

  async capabilities(): Promise<RecorderCapabilities | null> {
    const client = new ApexrecClient(this.deps.recorderCommand)
    this.capabilityRequests.add(client)
    try { return await client.hello() }
    catch { return null }
    finally {
      await client.close()
      this.capabilityRequests.delete(client)
    }
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

  /** 只允許目前（含收尾中、工作目錄尚未刪除）的錄影工作。 */
  private liveFor(sessionId: string): LiveSession {
    if (!this.active || this.active.id !== sessionId) throw new Error('錄影工作不存在或已收尾')
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
    live.on('match', (ev: 'match_start' | 'match_end', index: number) => {
      if (this.active?.live !== live) return
      if (ev === 'match_start') this.notice('matchStart', `第 ${index} 局開始`)
      else this.notice('matchEnd', `第 ${index} 局結束（計入擊殺 ${live.kills()}）`)
    })
    return live
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.operations.then(action)
    this.operations = result.then(() => {}, (error) => this.fail('internal', String(error)))
    return result
  }

  private canAutoStart(): boolean {
    return this.running && this.gamePid !== null && !this.active && !this.state.paused &&
      !this.manualStopped && !this.blocked && !this.retryTimer && this.deps.getSettings().autoRecord
  }

  private async begin(pid: number): Promise<boolean> {
    const settings = { ...this.deps.getSettings() }
    const outputDir = settings.outputDir ?? this.deps.getWatchFolders()[0] ?? this.deps.defaultOutputDir
    this.update({ ...IDLE_RECORDING_STATUS, paused: this.state.paused, phase: 'starting' })
    let session: ActiveSession | null = null
    try {
      if (!isSafeLocalDirPath(outputDir)) throw new RecorderError('output_invalid', '錄影資料夾必須是本機絕對路徑')
      await fs.promises.mkdir(outputDir, { recursive: true })
      const free = await diskFreeBytes(outputDir)
      this.update({ diskFreeBytes: free })
      if (diskLevel(free, settings) === 'stop') throw new RecorderError('disk_full', '磁碟剩餘空間低於停止門檻，無法開始錄影')
      const frames = await readFrames(this.deps.profileDir)
      const id = sessionId()
      const root = path.join(outputDir, '.sessions')
      await fs.promises.mkdir(root, { recursive: true })
      if ((await fs.promises.lstat(root)).isSymbolicLink()) throw new RecorderError('output_invalid', '錄影工作目錄不可使用連結')
      const dir = path.join(root, id)
      await fs.promises.mkdir(dir)
      await validateSessionDir(dir)
      const startedAt = Date.now()
      await writeJson(path.join(dir, 'recording.json'), { startedAt, postAnalysis: settings.postAnalysis })
      const client = new ApexrecClient(this.deps.recorderCommand)
      const live = this.createLive(id, dir)
      session = { pid, id, dir, outputDir, client, ending: false, warned: false, writes: Promise.resolve(), sequences: new Set(), live }
      this.active = session
      this.update({ sessionId: id, startedAt })
      const current = session
      client.on('event', (event: RecorderEvent) => this.onEvent(current, event))
      client.on('crash', (error: Error) => {
        if (this.active === current && !current.ending) void this.serialize(() => this.crashed(current, error))
      })
      await client.hello()
      if (!this.running || this.manualStopped || this.gamePid !== pid) throw new RecorderError('cancelled', '錄影啟動已取消')
      await client.startRecording({ pid, session_dir: dir, session_id: id,
        encode: { codec: settings.codec, encoder: settings.encoder, fps: settings.fps, height: settings.height, bitrate_kbps: settings.bitrateKbps },
        audio: { render: settings.renderDevice, capture: settings.captureDevice, mic_gain: settings.micGain, mic_enabled: settings.micEnabled }, frames })
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
      this.fail(code, `無法開始錄影：${String(error)}`)
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
        if (typeof event.encoder !== 'string' || !Number.isSafeInteger(event.width) || Number(event.width) <= 0 ||
            !Number.isSafeInteger(event.height) || Number(event.height) <= 0) return
        this.update({ phase: 'recording', encoder: event.encoder, width: Number(event.width), height: Number(event.height), error: null })
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
          // 段落只更新快照，隨每五秒 stats 或階段變化推播，避免每段都送 IPC。
          this.update({ segments: session.sequences.size, durationSec: Math.max(this.state.durationSec, event.pts + event.dur) }, false)
        }
        break
      case 'stats':
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
      case 'stopped':
        if (!session.ending) void this.serialize(() => this.crashed(session,
          new RecorderError('recorder_stopped', `錄影意外停止：${String(event.reason)}`)))
        break
    }
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
      this.fail('restart_limit', '錄影程序在 10 分鐘內已重啟 5 次，已停止重試')
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
        if (await this.finish()) this.fail('disk_full', '磁碟剩餘空間低於停止門檻，已停止錄影並收尾')
      } else if (level === 'warn' && !session.warned) {
        session.warned = true
        this.notice('diskWarn', `錄影磁碟剩餘 ${(bytes / 1024 ** 3).toFixed(1)} GB`)
      }
    } catch (error) {
      this.blocked = true
      if (await this.finish()) this.fail('disk_check_failed', `無法檢查錄影磁碟，已停止錄影：${String(error)}`)
    }
  }

  private async finish(): Promise<boolean> {
    const session = this.active
    if (!session) return true
    session.ending = true
    this.clearDiskTimer()
    try { await session.client.stop() }
    catch (error) { this.notice('error', `錄影程序停止失敗，將收尾已完成段落：${String(error)}`) }
    this.update({ phase: 'finalizing' })
    // 等 live 引擎送出最終 snapshot 並寫入 live.json，收尾才能轉成分析快取。
    await session.live.stop()
    try {
      await session.writes
      const paths = await finalizeSession(session.dir, this.deps)
      this.active = null
      this.idle()
      this.events.emit('live', { sessionId: session.id, finalized: [...paths] } satisfies LiveUpdate)
      if (paths.length) this.finalized(paths)
      return true
    } catch (error) {
      this.active = null
      this.blocked = true
      this.fail('finalize_failed', `錄影收尾失敗，已保留段落供下次重試：${String(error)}`)
      return false
    }
  }

  private recordEvent(session: ActiveSession, event: RecorderEvent): void {
    session.writes = session.writes.then(() => fs.promises.appendFile(path.join(session.dir, 'events.jsonl'),
      JSON.stringify({ ...event, wall: new Date().toISOString() }) + '\n'))
    // 立即掛上 rejection handler；finish 仍會檢查原始 promise 並保留工作目錄。
    void session.writes.catch(() => {})
  }

  private finalized(paths: string[]): void {
    this.events.emit('finalized', [...paths])
    this.notice('finalized', `已儲存：${paths.map((p) => path.basename(p)).join('、')}`)
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
  private notice(kind: RecordingNoticeKind, message: string): void { this.deps.notify(kind, message) }
  private cancelRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }
  private clearDiskTimer(): void {
    if (this.diskTimer) clearInterval(this.diskTimer)
    this.diskTimer = null
  }
}
