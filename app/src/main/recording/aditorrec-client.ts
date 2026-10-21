import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { EventEmitter } from 'events'
import { StringDecoder } from 'string_decoder'
import type { RecorderCapabilities, RecorderGpu } from '../../shared/recording'
import type { RecorderCommand } from './index'
import { tr } from '../../shared/locale'

const MAX_BYTES = 64 * 1024
/** `hello` may probe several GPUs and legitimately take a few seconds on some machines. */
export const HELLO_TIMEOUT_MS = 30_000
export type RecorderEvent = Record<string, unknown> & { ev: string }

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
  private decoder = new StringDecoder('utf8')
  private closing = false
  private closed: Promise<void> = Promise.resolve()

  constructor(private command: RecorderCommand) { super() }

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
      env: { ...process.env, ...this.command.env }, windowsHide: true, stdio: 'pipe'
    })
    this.proc = proc
    this.closed = new Promise((resolve) => {
      proc.once('close', (code, signal) => {
        this.proc = null
        const error = this.error('recorder_crashed', tr('錄影程序已結束（{code}）', { code: code ?? signal }))
        this.rejectAll(error)
        if (!this.closing) this.emit('crash', error)
        resolve()
      })
    })
    proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk))
    proc.stderr.on('data', (chunk: Buffer) => {
      this.stderr = Buffer.concat([this.stderr, chunk]).subarray(-MAX_BYTES)
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
    try {
      await Promise.all([started, this.request('start', args)])
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
        } else if (typeof msg.ev === 'string') this.emit('event', msg)
        else throw new Error()
      } catch { this.protocolError(); return }
    }
    if (Buffer.byteLength(this.buffer) > MAX_BYTES) this.protocolError()
  }

  private protocolError(): void {
    this.rejectAll(this.error('bad_reply', tr('錄影程序輸出的 JSON-lines 格式錯誤')))
    this.proc?.kill()
  }

  private error(code: string, message: string): RecorderError {
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
