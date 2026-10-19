/**
 * live 引擎（第 3 期，計畫 7 合約 1）：`aditor live --shm … --profile-dir … [--scene-dir …]`。
 * 讀 aditorrec 的共享記憶體小圖，stdout 每行一個 JSON（ready／snapshot／match_pending／match_cancel／match_start／match_end／stats／error）。
 *
 * - 以低於一般的優先序執行；當掉時以指數退避重啟（10 分鐘內最多 5 次），錄影本身不受影響。
 * - 重啟後的新程序只看得到重啟之後的影格：先前的事件保留（封存），新程序的事件只採用封存時間之後的部分。
 * - 停止：送 `{"cmd":"stop"}` 並關閉 stdin，等最終 snapshot 與程序結束；逾時就強制結束。
 */
import os from 'os'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { EventEmitter } from 'events'
import { StringDecoder } from 'string_decoder'
import type { LiveEvent } from '../../shared/recording'
import type { RecorderCommand } from './index'
import { tr } from '../../shared/locale'

/** snapshot 含整份事件清單，可能遠大於 aditorrec 的 64 KB 行長上限。 */
const MAX_LINE_BYTES = 8 * 1024 * 1024
const MAX_EVENTS = 20_000
const STDERR_TAIL = 16 * 1024
const RESTART_WINDOW_MS = 10 * 60 * 1000
const MAX_RESTARTS = 5
export const LIVE_STOP_TIMEOUT_MS = 5000

export interface LiveSpec { start: number; end: number }
/** live 引擎在最終 snapshot 附上的判定：complete＝結果等同離線分析，可直接當分析結果。 */
export interface LiveQuality { complete: boolean; reasons: string[]; hScale: number | null }
export interface LiveSnapshot { t: number; events: LiveEvent[]; spectating: LiveSpec[]; quality?: LiveQuality }
export interface LiveMatchEvent { ev: 'match_start' | 'match_end' | 'match_pending' | 'match_cancel'; t: number; reason: string }

export interface LiveEngineOptions {
  command: RecorderCommand
  /** 附加在 command.args 之後的 live 參數 */
  args: string[]
  /** 重啟退避基準（毫秒，第 n 次重啟等 base × 2^n）；測試注入 */
  restartBaseMs?: number
  stopTimeoutMs?: number
  /** 測試注入：設定程序優先序 */
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

/** 解析一行 snapshot；格式不符回傳 null（整行忽略）。 */
export function parseSnapshot(msg: Record<string, unknown>): LiveSnapshot | null {
  if (!finite(msg.t) || !Array.isArray(msg.events) || !Array.isArray(msg.spectating)) return null
  if (msg.events.length > MAX_EVENTS || msg.spectating.length > MAX_EVENTS) return null
  if (!msg.events.every(validEvent) || !msg.spectating.every(validSpec)) return null
  const snap: LiveSnapshot = { t: msg.t, events: msg.events as LiveEvent[], spectating: msg.spectating as LiveSpec[] }
  const q = msg.quality as Record<string, unknown> | undefined
  if (msg.final === true && q && typeof q === 'object' && typeof q.complete === 'boolean') {
    const reasons = Array.isArray(q.reasons) ? q.reasons.filter((r): r is string => typeof r === 'string').map((r) => r.slice(0, 64)) : []
    snap.quality = { complete: q.complete, reasons, hScale: finite(q.h_scale) ? q.h_scale : null }
  }
  return snap
}

/**
 * 合併封存（前一個程序）與新程序的快照：封存全部保留，新程序只取 `resumeT` 之後開始的事件與觀戰區間。
 * 事件 id 由時間組成（`a<毫秒>`），同一事件在兩邊 id 相同，以 id 去重。
 */
export function mergeIncarnations(archived: LiveSnapshot | null, fresh: LiveSnapshot, resumeT: number): LiveSnapshot {
  if (!archived) return fresh
  const ids = new Set(archived.events.map((e) => e.id))
  const events = [...archived.events, ...fresh.events.filter((e) => e.t > resumeT && !ids.has(e.id))]
    .sort((a, b) => a.t - b.t)
  const spectating = [...archived.spectating, ...fresh.spectating.filter((s) => s.start > resumeT)]
    .sort((a, b) => a.start - b.start)
  // 重啟過的程序只看到後半段：最終判定一律不完整。
  const quality = fresh.quality && { ...fresh.quality, complete: false, reasons: [...fresh.quality.reasons, 'restarted'] }
  return { t: Math.max(archived.t, fresh.t), events, spectating, ...(quality ? { quality } : {}) }
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

  /** 目前合併後的快照（含重啟前的事件）。 */
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
    } catch { /* stdin 已關閉：等程序自行結束或逾時 */ }
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
    proc.stdin.on('error', () => { /* 程序結束時寫入 stop 可能 EPIPE；由 close 處理 */ })
    proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk))
    proc.stderr.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString('utf8')).slice(-STDERR_TAIL) })
  }

  private crashed(message: string): void {
    // 封存目前事件；新程序從最新影格開始，只採用 lastT 之後的事件。
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

  /** 最終判定；沒有收到最終 snapshot（被 kill、放棄重啟）時為 null＝不可直接採用。 */
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
        // 有處理影格才代表引擎在運作；大廳沒有擊殺時不會送 snapshot，只能靠這個判斷健康與分析進度
        if (finite(msg.t) && finite(msg.frames) && msg.frames > 0) this.emit('progress', msg.t)
        break
      case 'error':
        this.emit('warning', tr('即時偵測錯誤（{code}）：{message}', { code: String(msg.code), message: String(msg.message) }))
        break
    }
  }
}
