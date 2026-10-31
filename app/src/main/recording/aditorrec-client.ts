import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { EventEmitter } from 'events'
import { StringDecoder } from 'string_decoder'
import type { RecorderCapabilities, RecorderGpu } from '../../shared/recording'
import type { RecorderCommand } from './index'
import { tr } from '../../shared/locale'
import { emitChildDiagnostic, RECORDER_AUDIO_WARNING_CODES, type ChildDiagnosticHandler } from '../../shared/child-diagnostics'

const MAX_BYTES = 64 * 1024
/** `hello` may probe several GPUs and legitimately take a few seconds on some machines. */
export const HELLO_TIMEOUT_MS = 30_000
export type RecorderEvent = Record<string, unknown> & { ev: string }

const UPTIME_BUCKETS: ReadonlyArray<readonly [number, string]> = [[10_000, '<10s'], [60_000, '<1m'], [600_000, '<10m'], [3_600_000, '<1h']]

/** The recorder reports failures as plain text, so the settings it was started with are the only context for grouping them by device and configuration. */
export function recorderTags(args: object): Record<string, string> {
  const { capture, encode, audio } = args as { capture?: unknown; encode?: Record<string, unknown> | null; audio?: Record<string, unknown> | null }
  const tags: Record<string, string> = {}
  const set = (key: string, value: unknown): void => {
    if (typeof value === 'number' && Number.isFinite(value)) tags[key] = String(Math.round(value))
    else if (typeof value === 'string') tags[key] = value
  }
  set('capture', capture)
  set('codec', encode?.codec)
  set('encoder', encode?.encoder)
  set('fps', encode?.fps)
  set('height', encode?.height)
  if (audio) {
    tags.mic = audio.mic_enabled === true ? 'on' : 'off'
    tags.system_audio = audio.render_enabled === false ? 'off' : 'on'
  }
  return tags
}

function uptimeBucket(ms: number): string {
  return UPTIME_BUCKETS.find(([limit]) => ms < limit)?.[1] ?? '>=1h'
}

export class RecorderError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'RecorderError'
  }
}

interface Pending {
  resolve: (reply: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class AditorrecClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<number, Pending>()
  private seq = 0
  private buffer = ''
  private stderr = Buffer.alloc(0)
  private diagnosticBuffer = ''
  private probeTags: Record<string, string> = {}
  private decoder = new StringDecoder('utf8')
  private closing = false
  private closed: Promise<void> = Promise.resolve()
  private startTags: Record<string, string> = {}
  private recordingSince: number | null = null

  constructor(private command: RecorderCommand, private onDiagnostic?: ChildDiagnosticHandler) { super() }

  get pid(): number | undefined { return this.proc?.pid }

  async hello(): Promise<RecorderCapabilities> {
    if (!this.proc) this.launch()
    const reply = await this.request('hello', {}, HELLO_TIMEOUT_MS)
    const audio = reply.audio as RecorderCapabilities['audio'] | undefined
    const validDevices = (devices: unknown): boolean => Array.isArray(devices) && devices.every(
      (d) => d && typeof d.id === 'string' && typeof d.name === 'string' && typeof d.default === 'boolean')
    // Older recorders do not report gpus; default to an empty list so the GPU picker stays usable.
    const gpus = reply.gpus === undefined ? [] : reply.gpus
    const validGpus = (value: unknown): value is RecorderGpu[] => Array.isArray(value) && value.every(
      (gpu) => gpu && typeof gpu === 'object' && typeof gpu.id === 'string' && typeof gpu.name === 'string' &&
        typeof gpu.vendor === 'string' && Array.isArray(gpu.encoders) &&
        gpu.encoders.every((encoder: unknown) => typeof encoder === 'string'))
    if (typeof reply.version !== 'string' || !Array.isArray(reply.encoders) ||
        !reply.encoders.every((e) => typeof e === 'string') || !validGpus(gpus) || !audio ||
        !validDevices(audio.render) || !validDevices(audio.capture)) {
      throw new RecorderError('bad_reply', tr('錄影程序的能力回覆格式錯誤'))
    }
    return { version: reply.version, encoders: reply.encoders, gpus, audio }
  }

  private launch(): void {
    const proc = spawn(this.command.command, this.command.args, {
      env: { ...process.env, ADITORREC_DIAGNOSTICS: '1', ...this.command.env }, windowsHide: true, stdio: 'pipe'
    })
    this.proc = proc
    this.closed = new Promise((resolve) => {
      proc.once('close', (code, signal) => {
        this.proc = null
        const exitCode: Record<string, string> = code === null ? {} : { exit_code: `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, '0')}` }
        const blocked = code !== null && (code >>> 0) === 0xC0E90002
        const hint = blocked ? ' Windows Application Control blocked the recorder or a dependency (0xC0E90002).' : ''
        const error = this.error('recorder_crashed', tr('錄影程序已結束（{code}）', { code: code ?? signal }) + hint, exitCode)
        this.rejectAll(error)
        if (!this.closing) this.emit('crash', error)
        resolve()
      })
    })
    proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk))
    proc.stderr.on('data', (chunk: Buffer) => {
      this.stderr = Buffer.concat([this.stderr, chunk]).subarray(-MAX_BYTES)
      // Only fixed native progress markers cross the telemetry boundary; raw stderr stays local.
      this.diagnosticBuffer += chunk.toString('utf8')
      let end: number
      while ((end = this.diagnosticBuffer.indexOf('\n')) >= 0) {
        const line = this.diagnosticBuffer.slice(0, end).trim()
        this.diagnosticBuffer = this.diagnosticBuffer.slice(end + 1)
        const match = line.match(/^ADITORREC_DIAG probe_stage=(gpu_enumerate|gpu_create|probe_open|probe_copy|probe_send|probe_flush|probe_close|audio_devices|ready) probe_encoder=(none|(?:hevc|h264|av1)_(?:nvenc|amf|qsv))$/)
        if (match) this.probeTags = { probe_stage: match[1], probe_encoder: match[2] }
      }
      if (this.diagnosticBuffer.length > MAX_BYTES) this.diagnosticBuffer = ''
    })
    proc.stdin.on('error', (error) => this.rejectAll(this.error('recorder_io', error.message)))
    proc.once('error', (error) => this.rejectAll(this.error('recorder_spawn', error.message)))
  }

  request(cmd: string, args: object = {}, timeoutMs = 30000): Promise<Record<string, unknown>> {
    const proc = this.proc
    if (!proc || this.closing) return Promise.reject(this.error('recorder_closed', tr('錄影程序未執行')))
    const id = ++this.seq
    const line = JSON.stringify({ ...args, id, cmd }) + '\n'
    if (Buffer.byteLength(line) > MAX_BYTES) return Promise.reject(this.error('bad_request', tr('錄影指令超過 64 KB')))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(this.error('recorder_timeout', tr('等待錄影指令 {cmd} 回覆逾時', { cmd })))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      proc.stdin.write(line, (error) => {
        if (!error) return
        this.settle(id, this.error('recorder_io', error.message))
      })
    })
  }

  async startRecording(args: object): Promise<void> {
    // `started` may arrive before the `start` response; startup completes only after both arrive.
    let onEvent!: (event: RecorderEvent) => void
    let onCrash!: (error: Error) => void
    let timer!: ReturnType<typeof setTimeout>
    const started = new Promise<void>((resolve, reject) => {
      onEvent = (event) => {
        if (event.ev === 'started') resolve()
        if (event.ev === 'error') reject(this.error(String(event.code), String(event.message)))
      }
      onCrash = reject
      this.on('event', onEvent)
      this.on('crash', onCrash)
      this.on('closed', onCrash)
      timer = setTimeout(() => reject(this.error('recorder_timeout', tr('等待錄影開始事件逾時'))), 30000)
    })
    this.startTags = recorderTags(args)
    try {
      await Promise.all([started, this.request('start', args)])
      this.recordingSince = Date.now()
    } finally {
      clearTimeout(timer)
      this.off('event', onEvent)
      this.off('crash', onCrash)
      this.off('closed', onCrash)
    }
  }

  async stop(): Promise<void> {
    try {
      if (this.proc && !this.closing) await this.request('stop', {}, 15000)
    } catch (error) {
      this.proc?.kill()
      throw error
    } finally {
      await this.close()
    }
  }

  async close(): Promise<void> {
    this.closing = true
    this.emit('closed', this.error('recorder_closed', tr('錄影程序已停止')))
    this.rejectAll(this.error('recorder_closed', tr('錄影程序已停止')))
    const proc = this.proc
    if (!proc) return
    proc.stdin.end()
    const timer = setTimeout(() => proc.kill(), 1000)
    try { await this.closed } finally { clearTimeout(timer) }
  }

  private onData(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk)
    let end: number
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).trim()
      this.buffer = this.buffer.slice(end + 1)
      if (Buffer.byteLength(line) > MAX_BYTES) { this.protocolError(); return }
      if (!line) continue
      try {
        const msg = JSON.parse(line)
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Error()
        if (typeof msg.id === 'number') {
          this.settle(msg.id, msg.ok === true ? msg : this.error(
            typeof msg.code === 'string' ? msg.code : 'bad_reply',
            typeof msg.message === 'string' ? msg.message : tr('錄影指令失敗')))
        } else if (typeof msg.ev === 'string') {
          if (msg.ev === 'error') this.error(String(msg.code ?? 'internal'), String(msg.message ?? 'Recorder error'))
          if (msg.ev === 'warning' && RECORDER_AUDIO_WARNING_CODES.has(msg.code) && typeof msg.message === 'string') {
            this.reportDiagnostic(msg.code, msg.message)
          }
          this.emit('event', msg)
        }
        else throw new Error()
      } catch { this.protocolError(); return }
    }
    if (Buffer.byteLength(this.buffer) > MAX_BYTES) this.protocolError()
  }

  private protocolError(): void {
    this.rejectAll(this.error('bad_reply', tr('錄影程序輸出的 JSON-lines 格式錯誤')))
    this.proc?.kill()
  }

  private reportDiagnostic(code: string, message: string, tags: Record<string, string> = {}): void {
    if (!this.closing) {
      const phase: Record<string, string> = this.recordingSince === null ? { phase: 'startup' } : { phase: 'recording', uptime: uptimeBucket(Date.now() - this.recordingSince) }
      emitChildDiagnostic(this.onDiagnostic, { component: 'rust-recorder', code, message, tags: { ...this.startTags, ...this.probeTags, ...phase, ...tags } })
    }
  }

  private error(code: string, message: string, tags: Record<string, string> = {}): RecorderError {
    this.reportDiagnostic(code, message, tags)
    const log = this.stderr.toString('utf8').trim()
    return new RecorderError(code, log ? `${message}\n${log}` : message)
  }

  private settle(id: number, value: Record<string, unknown> | Error): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (value instanceof Error) pending.reject(value)
    else pending.resolve(value)
  }

  private rejectAll(error: Error): void {
    for (const id of this.pending.keys()) this.settle(id, error)
  }
}
