/**
 * 一個錄影工作的即時狀態（第 3 期）：段落清單、live 引擎事件、對局起訖。
 * - `live.json`：最新快照（原子寫入，寫入期間的新快照合併成一次）。
 * - `events.jsonl`：match_pending／match_cancel／match_start／match_end 各一行（由 session 的寫入鏈負責，收尾前會等完）。
 * - 讀 init.mp4／段落只允許此工作目錄內、索引中的檔案。
 */
import fs from 'fs'
import path from 'path'
import { EventEmitter } from 'events'
import { isCounted } from '../../shared/types'
import type { LiveEvent, LiveMatch, LiveSegment, LiveState, LiveUpdate } from '../../shared/recording'
import { LiveEngine, type LiveMatchEvent, type LiveSnapshot, type LiveSpec } from './live-engine'
import { pruneSegments } from './prune'
import { initMimeType } from './mp4-codec'
import { writeJson } from './finalize'
import type { RecorderCommand } from './index'

const MAX_INIT_BYTES = 4 * 1024 * 1024
/** 2 秒段落在 150 Mbps 上限約 38 MB；留足餘裕但拒絕異常大檔。 */
const MAX_SEGMENT_BYTES = 256 * 1024 * 1024
export const LIVE_FILE = 'live.json'

export function segmentFile(seq: number): string {
  return `seg_${String(seq).padStart(6, '0')}.m4s`
}

/** 依 match 事件更新對局清單（不改動原陣列）。 */
export function applyMatchEvent(matches: LiveMatch[], event: LiveMatchEvent): LiveMatch[] {
  if (event.ev === 'match_pending' || event.ev === 'match_cancel') return matches
  const last = matches.at(-1)
  if (event.ev === 'match_start') {
    // 直接排下一場：上一局在新開局序列開始時結束。
    const closed = last && last.end === null ? [...matches.slice(0, -1), { start: last.start, end: Math.max(last.start, event.t) }] : matches
    return [...closed, { start: event.t, end: null }]
  }
  if (last && last.end === null) return [...matches.slice(0, -1), { start: last.start, end: Math.max(last.start, event.t) }]
  return matches
}

/** 本局計入的擊倒＋消滅（助攻與小隊抹殺不算）；沒有對局資訊時計整段錄影。 */
export function countKills(events: LiveEvent[], matches: LiveMatch[]): number {
  const last = matches.at(-1)
  return events.filter((e) => (e.type === 'knock' || e.type === 'elim') && isCounted(e) &&
    (!last || (e.t >= last.start && (last.end === null || e.t <= last.end)))).length
}

async function readConfined(dir: string, name: string, limit: number): Promise<Uint8Array> {
  const file = path.join(dir, name)
  if (path.dirname(file) !== dir) throw new Error('錄影檔案路徑無效')
  const stat = await fs.promises.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('錄影檔案不是一般檔案')
  if (stat.size > limit) throw new Error('錄影檔案過大')
  return new Uint8Array(await fs.promises.readFile(file))
}

export interface LiveSessionOptions {
  sessionId: string
  dir: string
  command?: RecorderCommand
  profileDir: string
  sceneDir?: string
  restartBaseMs?: number
  /** 寫一行到 events.jsonl（session 的寫入鏈） */
  recordEvent: (event: Record<string, unknown> & { ev: string }) => void
  notice: (message: string) => void
}

export class LiveSession extends EventEmitter {
  private segments: LiveSegment[] = []
  private matches: LiveMatch[] = []
  private snapshot: LiveSnapshot = { t: 0, events: [], spectating: [] }
  private mime: string | null = null
  private engine: LiveEngine | null = null
  private writing: Promise<void> = Promise.resolve()
  private dirty = false
  private width: number | null = null
  private height: number | null = null
  private pending: number | null = null
  private healthy = false
  /** 即時引擎已分析到的錄影時間（秒）；清理不會超過這個時間 */
  private analyzedT = -Infinity
  private failed = false
  private pruned = false
  private restartedAt = -Infinity

  constructor(private options: LiveSessionOptions) { super() }

  get sessionId(): string { return this.options.sessionId }

  /** apexrec `started` 帶共享記憶體名稱；沒有 live 引擎指令時只提供段落播放。 */
  startEngine(shm: string, width: number, height: number): void {
    this.width = width
    this.height = height
    const { command } = this.options
    if (!command || this.engine) return
    if (path.isAbsolute(command.command) && !fs.existsSync(command.command)) {
      this.options.notice(`找不到即時偵測引擎（${command.command}），錄影照常進行，收尾後再分析`)
      return
    }
    const args = ['--shm', shm, '--profile-dir', this.options.profileDir]
    if (this.options.sceneDir) args.push('--scene-dir', this.options.sceneDir)
    const engine = new LiveEngine({ command, args, restartBaseMs: this.options.restartBaseMs })
    this.engine = engine
    this.listen(engine)
    engine.start()
  }

  private listen(engine: EventEmitter): void {
    engine.on('snapshot', (snap: LiveSnapshot) => this.onSnapshot(snap))
    engine.on('progress', (t: number) => this.onProgress(t))
    engine.on('match', (event: LiveMatchEvent) => this.onMatch(event))
    engine.on('failed', (error: Error) => { this.failed = true; this.healthy = false; this.options.notice(error.message) })
    engine.on('warning', (message: string) => console.warn('[live]', message))
    engine.on('restarting', ({ message }: { message: string }) => {
      this.healthy = false
      if (this.pruned) this.failed = true
      this.restartedAt = Date.now()
      console.warn('[live] 重新啟動：', message)
    })
  }

  addSegment(segment: LiveSegment): void {
    if (this.segments.some((s) => s.seq === segment.seq)) return
    this.segments = [...this.segments, segment]
    this.emitUpdate({ segment })
  }

  async prune(): Promise<void> {
    const healthy = (): boolean => !!this.engine && this.healthy && !this.failed && Date.now() - this.restartedAt >= 30_000
    if (!healthy()) return
    const beganAt = Date.now()
    await pruneSegments(this.options.dir, this.segments, this.matches, this.pending, this.analyzedT, healthy, (sequences) => {
      if (!sequences.length) return
      this.pruned = true
      if (this.restartedAt >= beganAt) this.failed = true
      const removed = new Set(sequences)
      this.segments = this.segments.filter(s => !removed.has(s.seq))
      this.emitUpdate({ segments: [...this.segments] })
    })
  }

  hasSegment(seq: number): boolean { return this.segments.some((s) => s.seq === seq) }

  kills(): number { return countKills(this.snapshot.events, this.matches) }
  matchIndex(): number | null { return this.matches.length ? this.matches.length : null }

  async state(): Promise<LiveState> {
    if (!this.mime) {
      try { this.mime = initMimeType(await readConfined(this.options.dir, 'init.mp4', MAX_INIT_BYTES)) }
      catch (error) {
        // init.mp4 尚未寫出時稍後再試；格式錯誤只記錄。
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[live] 無法解析 init.mp4：', error)
      }
    }
    return {
      sessionId: this.options.sessionId, mime: this.mime, segments: [...this.segments],
      events: this.snapshot.events, spectating: this.snapshot.spectating, matches: [...this.matches]
    }
  }

  readInit(): Promise<Uint8Array> { return readConfined(this.options.dir, 'init.mp4', MAX_INIT_BYTES) }

  readSegment(seq: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(seq) || seq <= 0 || !this.hasSegment(seq)) return Promise.reject(new Error('段落不在錄影索引中'))
    return readConfined(this.options.dir, segmentFile(seq), MAX_SEGMENT_BYTES)
  }

  /** 停止 live 引擎（等最終 snapshot），再等 live.json 寫完。不丟出錯誤。 */
  async stop(): Promise<void> {
    try { await this.engine?.stop() } catch (error) { console.warn('[live] 停止失敗：', error) }
    await this.flush()
  }

  async flush(): Promise<void> {
    // 寫入期間可能又排入一次；直到沒有待寫為止。
    let pending = this.writing
    await pending
    while (pending !== this.writing) {
      pending = this.writing
      await pending
    }
  }

  private onProgress(t: number): void {
    this.healthy = true
    this.analyzedT = Math.max(this.analyzedT, t)
  }

  private onSnapshot(snap: LiveSnapshot): void {
    this.onProgress(snap.t)
    this.snapshot = snap
    this.scheduleWrite()
    this.emitUpdate({ events: snap.events, spectating: snap.spectating })
    this.emit('stats')
  }

  private onMatch(event: LiveMatchEvent): void {
    if (event.ev === 'match_pending') this.pending = event.t
    else if (event.ev === 'match_cancel' || event.ev === 'match_start') this.pending = null
    this.options.recordEvent({ ev: event.ev, t: event.t, reason: event.reason })
    if (event.ev === 'match_pending' || event.ev === 'match_cancel') {
      this.emit('match', event.ev, this.matches.length + 1, event.t)
      return
    }
    const next = applyMatchEvent(this.matches, event)
    if (next === this.matches) return
    this.matches = next
    this.scheduleWrite()
    this.emitUpdate({ match: { ...next[next.length - 1], index: next.length } })
    this.emit('stats')
    this.emit('match', event.ev, next.length, event.t)
  }

  private scheduleWrite(): void {
    if (this.dirty) return
    this.dirty = true
    this.writing = this.writing.then(async () => {
      this.dirty = false
      await writeJson(path.join(this.options.dir, LIVE_FILE), {
        version: 1, engine_version: this.engine?.engineVersion() ?? null,
        t: this.snapshot.t, events: this.snapshot.events, spectating: this.snapshot.spectating as LiveSpec[],
        matches: this.matches, width: this.width, height: this.height, quality: this.engine?.quality() ?? null
      })
    }).catch((error) => { console.warn('[live] 無法寫入 live.json：', error) })
  }

  private emitUpdate(patch: Omit<LiveUpdate, 'sessionId'>): void {
    this.emit('update', { sessionId: this.options.sessionId, ...patch } satisfies LiveUpdate)
  }
}
