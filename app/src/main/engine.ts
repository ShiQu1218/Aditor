import os from 'os'
import { spawn, ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { StringDecoder } from 'string_decoder'
import { emitChildDiagnostic, type ChildDiagnosticHandler } from '../shared/child-diagnostics'

export class EngineError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'EngineError'
    this.code = code
  }
}

interface PendingRequest {
  id: string
  sent: boolean
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  onProgress?: (p: { t: number; duration: number }) => void
}

export interface EngineClientOptions {
  onDiagnostic?: ChildDiagnosticHandler
  command: string
  args: string[]
  env?: Record<string, string>
  /** Test injection: set process priority. */
  setPriority?: (pid: number) => void
}

export class EngineClient extends EventEmitter {
  private opts: EngineClientOptions
  private proc: ChildProcess | null = null
  private stdoutBuf = ''
  private stdoutDecoder = new StringDecoder('utf8')
  private pending = new Map<string, PendingRequest>()
  private reqSeq = 0
  private engineVersion = ''
  private readyResolve: ((val: { engineVersion: string }) => void) | null = null
  private readyReject: ((err: Error) => void) | null = null
  private readyPromise: Promise<{ engineVersion: string }> | null = null
  private isStopping = false
  private crashTimes: number[] = []
  private maxCrashesInWindow = 3
  private crashWindowMs = 60000

  constructor(opts: EngineClientOptions) {
    super()
    this.opts = opts
  }

  async start(): Promise<{ engineVersion: string }> {
    this.isStopping = false
    return this._spawn()
  }

  private _spawn(): Promise<{ engineVersion: string }> {
    if (this.readyPromise) {
      return this.readyPromise
    }

    this.readyPromise = new Promise<{ engineVersion: string }>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject

      try {
        const p = spawn(this.opts.command, this.opts.args, {
          env: { ...process.env, ...this.opts.env },
          stdio: ['pipe', 'pipe', 'pipe']
        })
        this.proc = p
        this.stdoutBuf = ''
        this.stdoutDecoder = new StringDecoder('utf8')

        // Analysis can start while a game is running (per-match analysis, watched folders). Below-normal lets the game
        // keep its CPU time; FFmpeg processes spawned by the engine inherit this priority class on Windows.
        p.once('spawn', () => {
          if (p.pid === undefined) return
          try {
            if (this.opts.setPriority) this.opts.setPriority(p.pid)
            else os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL)
          } catch (err) {
            emitChildDiagnostic(this.opts.onDiagnostic, { component: 'python-engine', code: 'engine_priority', message: String(err) })
          }
        })

        p.stdout?.on('data', (chunk: Buffer) => {
          this._onData(chunk)
        })

        p.stderr?.on('data', (chunk: Buffer) => {
          // Keep for debugging/logging
          const msg = chunk.toString('utf-8')
          if (process.env.DEBUG_ENGINE) {
            console.error('[Engine stderr]', msg)
          }
        })

        p.on('error', (err) => {
          emitChildDiagnostic(this.opts.onDiagnostic, { component: 'python-engine', code: 'engine_spawn', message: err.message })
          if (this.readyReject) {
            this.readyReject(err)
            this.readyResolve = null
            this.readyReject = null
          }
        })

        p.on('close', (code) => {
          this._onClose(code)
        })
      } catch (err) {
        reject(err)
      }
    })

    return this.readyPromise
  }

  private _onData(chunk: Buffer): void {
    this.stdoutBuf += this.stdoutDecoder.write(chunk)
    let nlIdx: number
    while ((nlIdx = this.stdoutBuf.indexOf('\n')) !== -1) {
      const line = this.stdoutBuf.slice(0, nlIdx).trim()
      this.stdoutBuf = this.stdoutBuf.slice(nlIdx + 1)
      if (!line) continue
      this._handleLine(line)
    }
  }

  private _handleLine(line: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }

    if (msg.type === 'ready') {
      this.engineVersion = String(msg.engine_version || '')
      if (this.readyResolve) {
        this.readyResolve({ engineVersion: this.engineVersion })
        this.readyResolve = null
        this.readyReject = null
      }
      return
    }

    const id = msg.id as string
    if (!id) return
    const req = this.pending.get(id)
    if (!req) return

    if (msg.type === 'progress') {
      if (req.onProgress) {
        req.onProgress({
          t: Number(msg.t || 0),
          duration: Number(msg.duration || 0)
        })
      }
    } else if (msg.type === 'result') {
      this.pending.delete(id)
      req.resolve(msg.data)
    } else if (msg.type === 'error') {
      emitChildDiagnostic(this.opts.onDiagnostic, { component: 'python-engine', code: String(msg.code || 'internal'), message: String(msg.message || 'Unknown engine error'), exception: msg.exception })
      this.pending.delete(id)
      req.reject(new EngineError(String(msg.code || 'internal'), String(msg.message || 'unknown error')))
    }
  }

  private _onClose(_code: number | null): void {
    this.proc = null
    this.stdoutBuf = ''
    this.stdoutDecoder = new StringDecoder('utf8')
    this.readyPromise = null

    if (this.readyReject) {
      this.readyReject(new EngineError('engine_crashed', 'Engine closed before ready'))
      this.readyResolve = null
      this.readyReject = null
    }

    // Reject all pending requests
    const pendingList = Array.from(this.pending.values())
    this.pending.clear()
    for (const req of pendingList) {
      req.reject(new EngineError('engine_crashed', 'Engine process crashed unexpectedly'))
    }

    if (this.isStopping) {
      return
    }
    emitChildDiagnostic(this.opts.onDiagnostic, { component: 'python-engine', code: 'engine_crashed', message: `Python engine exited unexpectedly (${_code ?? 'signal'})` })

    // Record crash
    const now = Date.now()
    this.crashTimes.push(now)
    this.crashTimes = this.crashTimes.filter((t) => now - t <= this.crashWindowMs)

    this.emit('crash')

    if (this.crashTimes.length < this.maxCrashesInWindow) {
      // Auto restart
      this._spawn().catch(() => {})
    }
  }

  request<T>(
    cmd: string,
    args: object,
    onProgress?: (p: { t: number; duration: number }) => void
  ): { id: string; promise: Promise<T> } {
    const id = `req_${Date.now()}_${++this.reqSeq}`

    const promise = new Promise<T>((resolve, reject) => {
      // Check if dead due to repeated crashes
      const now = Date.now()
      this.crashTimes = this.crashTimes.filter((t) => now - t <= this.crashWindowMs)
      if (this.crashTimes.length >= this.maxCrashesInWindow && !this.proc) {
        return reject(
          new EngineError('engine_crashed', 'Engine has crashed 3 times in 60s and will not restart')
        )
      }

      this.pending.set(id, { id, sent: false, resolve: resolve as (val: unknown) => void, reject, onProgress })
      const fail = (error: unknown): void => {
        this.pending.delete(id)
        reject(error)
      }
      const sendReq = () => {
        const request = this.pending.get(id)
        if (!request) return
        if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) {
          return fail(new EngineError('engine_crashed', 'Engine process not available'))
        }
        request.sent = true
        const line = JSON.stringify({ id, cmd, args }) + '\n'
        this.proc.stdin.write(line, 'utf-8', (err) => {
          if (err) {
            this.pending.delete(id)
            reject(err)
          }
        })
      }

      if (!this.proc || this.readyResolve) {
        // Still starting or need restart
        this._spawn()
          .then(() => sendReq())
          .catch(fail)
      } else {
        sendReq()
      }
    })

    return { id, promise }
  }

  cancel(targetId: string): void {
    const request = this.pending.get(targetId)
    if (request && !request.sent) {
      this.pending.delete(targetId)
      request.reject(new EngineError('cancelled', 'Analysis cancelled before the engine was ready'))
      return
    }
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) return
    const cancelId = `cancel_${Date.now()}_${++this.reqSeq}`
    const line = JSON.stringify({ id: cancelId, cmd: 'cancel', args: { target: targetId } }) + '\n'
    this.proc.stdin.write(line, 'utf-8')
  }

  async stop(): Promise<void> {
    this.isStopping = true
    if (this.proc) {
      const p = this.proc
      this.proc = null
      return new Promise<void>((resolve) => {
        p.on('close', () => resolve())
        try {
          p.stdin?.end()
          p.kill()
        } catch {
          resolve()
        }
      })
    }
  }
}
