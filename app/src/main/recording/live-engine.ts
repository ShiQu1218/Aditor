/**
 * Live engine (phase 3, plan 7 contract 1): `aditor live --shm … --profile-dir … [--scene-dir …]`.
 * Reads thumbnails from aditorrec shared memory and writes one JSON object per stdout line (ready/snapshot/match_pending/match_cancel/match_start/match_end/stats/error).
 *
 * - Runs at below-normal priority; restarts with exponential backoff after a crash (up to 5 times in 10 minutes) without affecting recording.
 * - A restarted process sees only later frames: retain earlier events as archived and accept new events only after the archive time.
 * - To stop, send `{"cmd":"stop"}`, close stdin, and wait for the final snapshot and process exit; force termination on timeout.
 */
import os from 'os'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { EventEmitter } from 'events'
import { StringDecoder } from 'string_decoder'
import type { LiveEvent } from '../../shared/recording'
import type { RecorderCommand } from './index'
import { tr } from '../../shared/locale'

/** A snapshot contains the full event list and may exceed aditorrec's 64 KB line limit. */
const MAX_LINE_BYTES = 8 * 1024 * 1024
const MAX_EVENTS = 20_000
const STDERR_TAIL = 16 * 1024
const RESTART_WINDOW_MS = 10 * 60 * 1000
const MAX_RESTARTS = 5
export const LIVE_STOP_TIMEOUT_MS = 5000

export interface LiveSpec { start: number; end: number }
/** The live engine's final snapshot assessment; complete means equivalent to offline analysis and can be used directly. */
/** aspectSquash: the game aspect layout the engine detected with (absent means 16:9). */
export interface LiveQuality { complete: boolean; reasons: string[]; hScale: number | null; aspectSquash?: number }
/** A Valorant round from the scoreboard (recording time, seconds). */
export interface LiveRound { start: number; end: number; winner: 'ally' | 'enemy'; ally: number; enemy: number }
export interface LiveSnapshot { t: number; events: LiveEvent[]; spectating: LiveSpec[]; quality?: LiveQuality; rounds?: LiveRound[] }
export interface LiveMatchEvent { ev: 'match_start' | 'match_end' | 'match_pending' | 'match_cancel'; t: number; reason: string }

export interface LiveEngineOptions {
  command: RecorderCommand
  /** Live arguments appended after command.args. */
  args: string[]
  /** Restart backoff base in milliseconds (the nth restart waits base × 2^n); test injection. */
  restartBaseMs?: number
  stopTimeoutMs?: number
  /** Test injection: set process priority. */
  setPriority?: (pid: number) => void
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function validEvent(e: unknown): e is LiveEvent {
  if (!e || typeof e !== 'object') return false
  const r = e as Record<string, unknown>
  return typeof r.id === 'string' && r.id.length > 0 && r.id.length <= 64 && finite(r.t) && r.t >= 0 &&
    typeof r.type === 'string' && r.type.length <= 32
}

function validSpec(s: unknown): s is LiveSpec {
  if (!s || typeof s !== 'object') return false
  const r = s as Record<string, unknown>
  return finite(r.start) && finite(r.end) && r.start >= 0 && r.end >= r.start
}

function validRound(r: unknown): boolean {
  const x = r as Record<string, unknown>
  return !!x && typeof x === 'object' && finite(x.start) && finite(x.end) && x.end >= x.start &&
    (x.winner === 'ally' || x.winner === 'enemy') && finite(x.ally) && finite(x.enemy)
}

/** Parse a snapshot line; return null for invalid input (ignore the entire line). */
export function parseSnapshot(msg: Record<string, unknown>): LiveSnapshot | null {
  if (!finite(msg.t) || !Array.isArray(msg.events) || !Array.isArray(msg.spectating)) return null
  if (msg.events.length > MAX_EVENTS || msg.spectating.length > MAX_EVENTS) return null
  if (!msg.events.every(validEvent) || !msg.spectating.every(validSpec)) return null
  const snap: LiveSnapshot = { t: msg.t, events: msg.events as LiveEvent[], spectating: msg.spectating as LiveSpec[] }
  if (Array.isArray(msg.rounds) && msg.rounds.length <= MAX_EVENTS && msg.rounds.every(validRound)) snap.rounds = msg.rounds as LiveRound[]
  const q = msg.quality as Record<string, unknown> | undefined
  if (msg.final === true && q && typeof q === 'object' && typeof q.complete === 'boolean') {
    const reasons = Array.isArray(q.reasons) ? q.reasons.filter((r): r is string => typeof r === 'string').map((r) => r.slice(0, 64)) : []
    snap.quality = { complete: q.complete, reasons, hScale: finite(q.h_scale) ? q.h_scale : null,
      ...(finite(q.aspect_squash) ? { aspectSquash: q.aspect_squash } : {}) }
  }
  return snap
}

/**
 * Merge archived snapshots from the previous process with the new process: keep all archived
 * data, and take only events and spectator intervals that start after `resumeT` from the new process.
 * Event IDs are time-based (`a<milliseconds>`); matching IDs are deduplicated.
 */
export function mergeIncarnations(archived: LiveSnapshot | null, fresh: LiveSnapshot, resumeT: number): LiveSnapshot {
  if (!archived) return fresh
  const ids = new Set(archived.events.map((e) => e.id))
  const events = [...archived.events, ...fresh.events.filter((e) => e.t > resumeT && !ids.has(e.id))]
    .sort((a, b) => a.t - b.t)
  const spectating = [...archived.spectating, ...fresh.spectating.filter((s) => s.start > resumeT)]
    .sort((a, b) => a.start - b.start)
  // A restarted process sees only the latter part, so its final assessment is always incomplete.
  const quality = fresh.quality && { ...fresh.quality, complete: false, reasons: [...fresh.quality.reasons, 'restarted'] }
  const rounds = archived.rounds || fresh.rounds
    ? [...(archived.rounds ?? []), ...(fresh.rounds ?? []).filter((r) => r.end > resumeT)] : undefined
  return { t: Math.max(archived.t, fresh.t), events, spectating, ...(quality ? { quality } : {}), ...(rounds ? { rounds } : {}) }
}

export class LiveEngine extends EventEmitter {
  private gaveUp = false
  private proc: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private decoder = new StringDecoder('utf8')
  private stderr = ''
  private stopping = false
  private closed: Promise<void> = Promise.resolve()
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private restarts: number[] = []
  private archived: LiveSnapshot | null = null
  private current: LiveSnapshot | null = null
  private resumeT = -1
  private lastT = 0
  private version: string | null = null

  constructor(private options: LiveEngineOptions) { super() }

  start(): void {
    if (this.proc || this.stopping) return
    this.launch()
  }

  /** Current merged snapshot, including events from before restarts. */
  snapshot(): LiveSnapshot | null { return this.current }
  engineVersion(): string | null { return this.version }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    const proc = this.proc
    if (!proc) return
    try {
      proc.stdin.write('{"cmd":"stop"}\n')
      proc.stdin.end()
    } catch { /* stdin is closed; wait for process exit or timeout. */ }
    const timer = setTimeout(() => proc.kill(), this.options.stopTimeoutMs ?? LIVE_STOP_TIMEOUT_MS)
    try { await this.closed } finally { clearTimeout(timer) }
  }

  private launch(): void {
    const { command, args } = this.options
    let proc: ChildProcessWithoutNullStreams
    try {
      proc = spawn(command.command, [...command.args, ...args], {
        env: { ...process.env, ...command.env }, windowsHide: true, stdio: 'pipe'
      })
    } catch (error) {
      this.crashed(tr('無法啟動即時偵測：{error}', { error: String(error) }))
      return
    }
    this.proc = proc
    this.buffer = ''
    this.decoder = new StringDecoder('utf8')
    this.stderr = ''
    proc.once('spawn', () => {
      if (proc.pid === undefined) return
      try {
        if (this.options.setPriority) this.options.setPriority(proc.pid)
        else os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL)
      } catch (error) { this.emit('warning', tr('無法降低即時偵測的優先序：{error}', { error: String(error) })) }
    })
    this.closed = new Promise((resolve) => {
      proc.once('close', (code, signal) => {
        this.proc = null
        if (!this.stopping) this.crashed(tr('即時偵測已結束（{code}）', { code: code ?? signal }) + (this.stderr ? `\n${this.stderr.trim()}` : ''))
        resolve()
      })
    })
    proc.once('error', (error) => this.emit('warning', tr('即時偵測程序錯誤：{message}', { message: error.message })))
    proc.stdin.on('error', () => { /* Writing stop may hit EPIPE after process exit; close handles it. */ })
    proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk))
    proc.stderr.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString('utf8')).slice(-STDERR_TAIL) })
  }

  private crashed(message: string): void {
    // Archive current events; the new process starts at the latest frame, so accept only events after lastT.
    this.archived = this.current
    this.resumeT = this.lastT
    const now = Date.now()
    this.restarts = this.restarts.filter((time) => now - time < RESTART_WINDOW_MS)
    if (this.restarts.length >= MAX_RESTARTS) {
      this.gaveUp = true
      this.emit('failed', new Error(tr('即時偵測在 10 分鐘內已重啟 {max} 次，本次錄影停止即時偵測（錄影不受影響）：{message}', { max: MAX_RESTARTS, message })))
      return
    }
    const delay = (this.options.restartBaseMs ?? 1000) * 2 ** this.restarts.length
    this.restarts.push(now)
    this.emit('restarting', { delayMs: delay, message })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (!this.stopping) this.launch()
    }, delay)
    this.restartTimer.unref()
  }

  /** Final assessment; null when no final snapshot arrived (killed or restart abandoned), so it cannot be used directly. */
  quality(): LiveQuality | null {
    const q = this.current?.quality
    if (!q) return null
    return this.gaveUp ? { ...q, complete: false, reasons: [...q.reasons, 'gave_up'] } : q
  }

  private onData(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk)
    let end: number
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).trim()
      this.buffer = this.buffer.slice(end + 1)
      if (line) this.onLine(line)
    }
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.buffer = ''
      this.emit('warning', tr('即時偵測輸出的單行過長，已略過'))
    }
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line)
      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.ev !== 'string') throw new Error()
    } catch {
      this.emit('warning', tr('即時偵測輸出的 JSON 格式錯誤，已略過該行'))
      return
    }
    if (finite(msg.t)) this.lastT = Math.max(this.lastT, msg.t)
    switch (msg.ev) {
      case 'ready':
        if (typeof msg.engine_version === 'string') this.version = msg.engine_version.slice(0, 64)
        this.emit('ready')
        break
      case 'snapshot': {
        const snap = parseSnapshot(msg)
        if (!snap) { this.emit('warning', tr('即時偵測的 snapshot 格式錯誤，已略過')); return }
        this.current = mergeIncarnations(this.archived, snap, this.resumeT)
        this.emit('snapshot', this.current)
        break
      }
      case 'match_pending':
      case 'match_cancel':
      case 'match_start':
      case 'match_end':
        if (!finite(msg.t) || msg.t < 0) return
        this.emit('match', { ev: msg.ev, t: msg.t, reason: typeof msg.reason === 'string' ? msg.reason.slice(0, 200) : '' })
        break
      case 'stats':
        // Processed frames indicate the engine is running. With no lobby kills it sends no snapshot, so use this to track health and analysis progress.
        if (finite(msg.t) && finite(msg.frames) && msg.frames > 0) this.emit('progress', msg.t)
        break
      case 'error':
        this.emit('warning', tr('即時偵測錯誤（{code}）：{message}', { code: String(msg.code), message: String(msg.message) }))
        break
    }
  }
}
