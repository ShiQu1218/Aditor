import fs from 'fs'
import path from 'path'
import { EventEmitter } from 'events'
import type { RecordingSettings } from '../../shared/recording'
import { writeJson } from './finalize'
import { ObsClient } from './obs-client'
import { tr } from '../../shared/locale'

const OBS_STOP_POLL_MS = 100
/** 逐局開始錄影前，最多等上一局的 OBS 錄影停止這麼久 */
const OBS_MATCH_RESTART_WAIT_MS = 10_000

export interface ObsMatch {
  index: number
  recordStartedAt: number
  outputPath?: string
  stopped: boolean
  liveCached: boolean
  analysisQueued: boolean
  liveTrusted: boolean
  confirmed?: boolean
  cancelled?: boolean
  added?: boolean
}

export interface ObsMetadata {
  outputPath?: string
  recordStartedAt: number
  captureStartedAt: number
  adopted: boolean
}

/** OBS 連線與檔案時間軸；斷線時不影響 aditorrec 或 live 引擎。 */
export class ObsRecording extends EventEmitter {
  readonly client = new ObsClient()
  readonly meta: ObsMetadata = { recordStartedAt: Date.now(), captureStartedAt: Date.now(), adopted: false }
  private writes: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private ready = false
  private attempt = 0
  private reconnecting: Promise<void> | null = null
  private stopping = false
  stopped = false
  readonly matches: ObsMatch[] = []
  get perMatch(): boolean { return this.settings.mode === 'match' && !this.meta.adopted }
  get recording(): boolean { return !this.stopped && (!this.perMatch || !!this.matches.at(-1)) }

  constructor(private dir: string, private settings: RecordingSettings, private password: string | undefined,
    private notice: (message: string) => void, private reconnectBaseMs = 1000) {
    super()
    this.client.on('record', (event: { outputState: string; outputPath?: string }) => {
      if (event.outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED' && !this.meta.adopted) {
        this.meta.recordStartedAt = Date.now()
        const match = this.matches.at(-1)
        if (match && !match.stopped) {
          match.recordStartedAt = this.meta.recordStartedAt
          if (event.outputPath) match.outputPath = event.outputPath
        }
        this.persist()
      }
      if (event.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') {
        this.stopped = true
        const match = this.matches.at(-1)
        if (match && !match.stopped) { match.stopped = true; match.outputPath = event.outputPath || match.outputPath }
        if (event.outputPath) this.meta.outputPath = event.outputPath
        this.persist()
        this.emit('stopped')
      }
    })
    this.client.on('disconnected', () => {
      if (!this.ready || this.closed || this.stopping || this.stopped) return
      this.notice(tr('OBS 連線中斷，即時偵測繼續，正在嘗試重新連線'))
      this.scheduleReconnect()
    })
  }

  private connect(): Promise<void> { return this.client.connect(this.settings.obsHost, this.settings.obsPort, this.password) }

  /** `stopGraceUntil`：剛停止自己的錄影時，OBS 仍會短暫回報錄影中；等它停下，不誤當成使用者的錄影沿用。 */
  async start(stopGraceUntil = 0): Promise<void> {
    await this.connect()
    let status = await this.client.status()
    while (status.outputActive && Date.now() < stopGraceUntil) {
      await new Promise((resolve) => setTimeout(resolve, OBS_STOP_POLL_MS))
      status = await this.client.status()
    }
    this.meta.adopted = status.outputActive
    if (status.outputActive) {
      if (!Number.isFinite(status.outputDuration) || status.outputDuration < 0) throw new Error(tr('OBS 錄影時間回覆無效'))
      this.meta.recordStartedAt = Date.now() - status.outputDuration
    } else if (this.settings.mode !== 'match') { this.meta.recordStartedAt = Date.now(); await this.client.start() }
    else this.stopped = true
    this.ready = true
    this.persist()
    await this.flush()
  }

  async startMatch(index: number, confirmed = true): Promise<void> {
    if (!this.perMatch) return
    if (this.matches.at(-1)?.stopped === false) throw new Error(tr('上一局 OBS 錄影尚未完成，已保留工作'))
    if (!this.client.connected) await this.connect()
    // 連續排隊時上一局剛 StopRecord，OBS 還在寫檔尾、仍回報錄影中；等它真正停下。
    const waitUntil = Date.now() + OBS_MATCH_RESTART_WAIT_MS
    let status = await this.client.status()
    while (status.outputActive && Date.now() < waitUntil) {
      await new Promise((resolve) => setTimeout(resolve, OBS_STOP_POLL_MS))
      status = await this.client.status()
    }
    if (status.outputActive) throw new Error(tr('OBS 已有其他錄影，無法開始逐局錄影'))
    this.stopping = false
    this.stopped = false
    delete this.meta.outputPath
    this.matches.push({ index, confirmed, recordStartedAt: Date.now(), stopped: false, liveCached: false, analysisQueued: false, liveTrusted: false })
    this.persist()
    await this.flush()
    try { await this.client.start() }
    catch (error) {
      // 指令可能已送達但回覆遺失；保留未完成狀態，交由復原確認。
      this.persist()
      await this.flush()
      throw error
    }
    this.persist()
    await this.flush()
  }

  async captureStarted(now: number): Promise<void> {
    let startedAt = now
    try {
      const meta = JSON.parse(await fs.promises.readFile(path.join(this.dir, 'session.json'), 'utf8'))
      const parsed = Date.parse(meta.started_at)
      if (Number.isFinite(parsed)) startedAt = parsed
    } catch { /* started 事件是舊版錄影器的替代時間來源 */ }
    this.meta.captureStartedAt = startedAt
    this.persist()
    await this.flush()
  }

  private persist(): void {
    const snapshot = { ...this.meta }
    const matches = this.matches.map((match) => ({ ...match }))
    this.writes = this.writes.then(async () => {
      await writeJson(path.join(this.dir, 'obs.json'), snapshot)
      if (this.perMatch) await writeJson(path.join(this.dir, 'obs-matches.json'), matches)
    })
    void this.writes.catch(() => {})
  }
  async save(): Promise<void> { this.persist(); await this.flush() }
  async flush(): Promise<void> { await this.writes }

  private scheduleReconnect(): void {
    if (this.timer || this.closed || this.stopping) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.ensureConnected().catch(() => this.scheduleReconnect())
    }, Math.min(30000, this.reconnectBaseMs * 2 ** Math.min(this.attempt++, 5)))
    this.timer.unref()
  }

  private ensureConnected(): Promise<void> {
    this.reconnecting ??= this.reconnect().finally(() => { this.reconnecting = null })
    return this.reconnecting
  }

  private async reconnect(): Promise<void> {
    await this.connect()
    if (this.closed) { await this.client.close(); return }
    const status = await this.client.status()
    this.attempt = 0
    if (!status.outputActive && !this.stopped) {
      // v5 不提供已錯過停止事件的路徑，不猜測或掃描使用者的 OBS 資料夾。
      this.stopped = true
      this.notice(tr('OBS 已停止錄影；若停止事件在斷線期間遺失，請手動匯入 OBS 影片'))
      this.emit('stopped')
    }
  }

  /** true＝可收尾；沿用的錄影尚未停止時留給停止事件處理。 */
  async stop(): Promise<boolean> {
    if (this.meta.adopted) return this.stopped
    this.stopping = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.stopped) {
      try {
        if (this.reconnecting) await this.reconnecting
        if (!this.client.connected) await this.ensureConnected()
        if (!this.stopped) {
          const outputPath = await this.client.stop()
          if (outputPath) this.meta.outputPath = outputPath
          this.stopped = true
          const match = this.matches.at(-1)
          if (match) { match.stopped = true; match.outputPath = outputPath || match.outputPath }
          this.persist()
        }
      } catch {
        this.notice(tr('無法停止 OBS 錄影，請在 OBS 確認並手動停止；即時偵測已結束'))
      }
    }
    await this.flush()
    return this.perMatch ? this.stopped : true
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.client.close()
    await this.reconnecting?.catch(() => {})
    await this.client.close()
    await this.flush()
  }
}
