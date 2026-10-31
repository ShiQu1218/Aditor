/**
 * Live state for one recording session (phase 3): segment list, live engine events, and match boundaries.
 * - `live.json`: latest snapshot (atomic writes; snapshots arriving during a write are coalesced).
 * - `events.jsonl`: one line per match_pending/match_cancel/match_start/match_end event (written by the session queue, which is drained before finalization).
 * - Read init.mp4 and segments only from indexed files inside this session directory.
 */
import fs from 'fs'
import path from 'path'
import { EventEmitter } from 'events'
import { isCounted } from '../../shared/types'
import { DEFAULT_GAME, type GameId } from '../../shared/games'
import type { LiveEvent, LiveMatch, LiveSegment, LiveState, LiveUpdate } from '../../shared/recording'
import { LiveEngine, type LiveMatchEvent, type LiveSnapshot, type LiveSpec } from './live-engine'
import { pruneSegments } from './prune'
import { initMimeType } from './mp4-codec'
import { LIVE_COMPLETE_FILE, writeJson } from './finalize'
import type { RecorderCommand } from './index'
import { tr } from '../../shared/locale'
import type { ChildDiagnosticHandler } from '../../shared/child-diagnostics'

const MAX_INIT_BYTES = 4 * 1024 * 1024
/** A 2-second segment at the 150 Mbps limit is about 38 MB; allow headroom but reject abnormally large files. */
const MAX_SEGMENT_BYTES = 256 * 1024 * 1024
export const LIVE_FILE = 'live.json'

export function segmentFile(seq: number): string {
  return `seg_${String(seq).padStart(6, '0')}.m4s`
}

/** Update the match list from match events without mutating the original array. */
export function applyMatchEvent(matches: LiveMatch[], event: LiveMatchEvent): LiveMatch[] {
  if (event.ev === 'match_pending' || event.ev === 'match_cancel') return matches
  const last = matches.at(-1)
  if (event.ev === 'match_start') {
    // A restarted engine sees only later frames; the first return to the HUD/results screen still belongs to the current match.
    if (last?.end === null && (event.reason === 'initial_match' || event.reason === 'initial_summary')) return matches
    // If the next match starts directly, end the previous one when the new opening sequence begins.
    const closed = last && last.end === null ? [...matches.slice(0, -1), { start: last.start, end: Math.max(last.start, event.t) }] : matches
    return [...closed, { start: event.t, end: null }]
  }
  if (last && last.end === null) return [...matches.slice(0, -1), { start: last.start, end: Math.max(last.start, event.t) }]
  return matches
}

/** Count this match's knocks and kills (Valorant kills too; not assists, squad wipes or deaths); count the full recording when match data is unavailable. */
export function countKills(events: LiveEvent[], matches: LiveMatch[]): number {
  const last = matches.at(-1)
  return events.filter((e) => (e.type === 'knock' || e.type === 'elim' || e.type === 'kill') && isCounted(e) &&
    (!last || (e.t >= last.start && (last.end === null || e.t <= last.end)))).length
}

async function readConfined(dir: string, name: string, limit: number): Promise<Uint8Array> {
  const file = path.join(dir, name)
  if (path.dirname(file) !== dir) throw new Error(tr('錄影檔案路徑無效'))
  const stat = await fs.promises.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(tr('錄影檔案不是一般檔案'))
  if (stat.size > limit) throw new Error(tr('錄影檔案過大'))
  return new Uint8Array(await fs.promises.readFile(file))
}

export interface LiveSessionOptions {
  onDiagnostic?: ChildDiagnosticHandler
  sessionId: string
  dir: string
  command?: RecorderCommand
  profileDir: string
  sceneDir?: string
  /** Game render resolution (`WxH`) from the game config, passed as `--aspect` so detection follows the HUD layout. */
  aspect?: string | null
  /** Passed as `--game` for games other than the engine default (Apex). */
  game?: GameId
  restartBaseMs?: number
  /** Write one line to events.jsonl (through the session write queue). */
  recordEvent: (event: Record<string, unknown> & { ev: string }) => void
  notice: (message: string) => void
}

export class LiveSession extends EventEmitter {
  private segments: LiveSegment[] = []
  private segmentIds = new Set<number>()
  private matches: LiveMatch[] = []
  private snapshot: LiveSnapshot = { t: 0, events: [], spectating: [] }
  private mime: string | null = null
  private engine: LiveEngine | null = null
  private writing: Promise<void> = Promise.resolve()
  private dirty = false
  private writeError: unknown = null
  private width: number | null = null
  private height: number | null = null
  private pending: number | null = null
  private healthy = false
  /** Recording time in seconds processed by the live engine; cleanup never goes beyond it. */
  private analyzedT = -Infinity
  private failed = false
  private pruned = false
  private restartedAt = -Infinity
  /** Wall time (ms) when aditorrec reported capture started; recording time 0 is about then. */
  private capturedAt: number | null = null
  /** The game client's last match boundary before capture started; an open match is replayed at time 0. */
  private earlyClientMatch: 'match_start' | 'match_end' | null = null

  constructor(private options: LiveSessionOptions) { super() }

  get sessionId(): string { return this.options.sessionId }

  /** aditorrec `started` includes the shared-memory name; without a live engine command, provide segment playback only. */
  startEngine(shm: string, width: number, height: number): void {
    this.width = width
    this.height = height
    this.capturedAt = Date.now()
    if (this.earlyClientMatch === 'match_start') this.clientMatch('match_start', this.capturedAt)
    this.earlyClientMatch = null
    const { command } = this.options
    if (!command || this.engine) return
    if (path.isAbsolute(command.command) && !fs.existsSync(command.command)) {
      this.options.notice(tr('找不到即時偵測引擎（{command}），錄影照常進行，收尾後再分析', { command: command.command }))
      return
    }
    const args = ['--shm', shm, '--profile-dir', this.options.profileDir]
    if (this.options.sceneDir) args.push('--scene-dir', this.options.sceneDir)
    if (this.options.aspect) args.push('--aspect', this.options.aspect)
    if (this.options.game && this.options.game !== DEFAULT_GAME) args.push('--game', this.options.game)
    const engine = new LiveEngine({ command, args, restartBaseMs: this.options.restartBaseMs, onDiagnostic: this.options.onDiagnostic })
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
      console.warn('[live] Restarting:', message)
    })
  }

  addSegment(segment: LiveSegment): void {
    if (this.segmentIds.has(segment.seq)) return
    this.segmentIds.add(segment.seq)
    this.segments.push(segment)
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
      for (const seq of removed) this.segmentIds.delete(seq)
      this.segments = this.segments.filter(s => !removed.has(s.seq))
      this.scheduleWrite()
      this.emitUpdate({ segments: [...this.segments] })
    })
    await this.flush()
  }

  hasSegment(seq: number): boolean { return this.segmentIds.has(seq) }

  kills(): number { return countKills(this.snapshot.events, this.matches) }
  matchIndex(): number | null { return this.matches.length ? this.matches.length : null }

  async state(): Promise<LiveState> {
    if (!this.mime) {
      try { this.mime = initMimeType(await readConfined(this.options.dir, 'init.mp4', MAX_INIT_BYTES)) }
      catch (error) {
        // Retry later if init.mp4 has not been written yet; only log malformed files.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[live] Failed to parse init.mp4:', error)
      }
    }
    return {
      sessionId: this.options.sessionId, mime: this.mime, segments: [...this.segments],
      events: this.snapshot.events, spectating: this.snapshot.spectating, matches: [...this.matches]
    }
  }

  readInit(): Promise<Uint8Array> { return readConfined(this.options.dir, 'init.mp4', MAX_INIT_BYTES) }

  readSegment(seq: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(seq) || seq <= 0 || !this.hasSegment(seq)) return Promise.reject(new Error(tr('段落不在錄影索引中')))
    return readConfined(this.options.dir, segmentFile(seq), MAX_SEGMENT_BYTES)
  }

  /** Stop the live engine and persist its final snapshot; a failed write must preserve the recording for recovery. */
  async stop(): Promise<void> {
    try { await this.engine?.stop() } catch (error) { console.warn('[live] Stop failed:', error) }
    await this.flush()
    // Set the marker only if detection stayed healthy throughout. In per-match mode, no matches at finalization means the user stayed in the lobby, so do not output the full recording.
    // A killed engine sends no final snapshot and a lossy one reports incomplete; both may have missed a match, so keep the footage.
    if (!this.engine || !this.healthy || this.failed || this.engine.quality()?.complete !== true) return
    try { await writeJson(path.join(this.options.dir, LIVE_COMPLETE_FILE), { version: 1 }) }
    catch (error) { console.warn('[live] Failed to write detection completion marker:', error) }
  }

  async flush(): Promise<void> {
    // Another write may be queued while this one is in progress; continue until the queue is empty.
    let pending = this.writing
    await pending
    while (pending !== this.writing) {
      pending = this.writing
      await pending
    }
    if (this.writeError) throw this.writeError
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

  /** Match boundaries from the game client (Valorant's Riot Client), at wall time `at` (ms). */
  clientMatch(ev: 'match_start' | 'match_end', at: number): void {
    if (this.capturedAt === null) {
      this.earlyClientMatch = ev
      return
    }
    this.onMatch({ ev, t: Math.max(0, (at - this.capturedAt) / 1000), reason: 'game_client' })
  }

  private onMatch(event: LiveMatchEvent): void {
    const originalT = event.t
    const retainedFrom = this.retainedFrom()
    if (event.ev === 'match_start' && retainedFrom !== undefined && event.t < retainedFrom) {
      event = { ...event, t: retainedFrom }
    }
    const next = applyMatchEvent(this.matches, event)
    if (event.ev === 'match_start' && next === this.matches) return
    if (event.t !== originalT) console.warn('[live] Clamped match start after pruning:', originalT, '->', event.t)
    if (event.ev === 'match_pending') this.pending = event.t
    else if (event.ev === 'match_cancel' || event.ev === 'match_start') this.pending = null
    this.options.recordEvent({ ev: event.ev, t: event.t, reason: event.reason })
    if (event.ev === 'match_pending' || event.ev === 'match_cancel') {
      this.emit('match', event.ev, this.matches.length + 1, event.t)
      return
    }
    if (next === this.matches) return
    this.matches = next
    this.scheduleWrite()
    this.emitUpdate({ match: { ...next[next.length - 1], index: next.length } })
    this.emit('stats')
    this.emit('match', event.ev, next.length, event.t)
  }

  private retainedFrom(): number | undefined {
    return this.pruned && this.segments.length ? this.segments.reduce((first, s) => Math.min(first, s.pts), Infinity) : undefined
  }

  private scheduleWrite(): void {
    if (this.dirty) return
    this.dirty = true
    this.writing = this.writing.then(async () => {
      this.dirty = false
      await writeJson(path.join(this.options.dir, LIVE_FILE), {
        version: 1, engine_version: this.engine?.engineVersion() ?? null,
        t: this.snapshot.t, events: this.snapshot.events, spectating: this.snapshot.spectating as LiveSpec[],
        ...(this.snapshot.rounds ? { rounds: this.snapshot.rounds } : {}),
        matches: this.matches, retained_from: this.retainedFrom(),
        width: this.width, height: this.height, quality: this.engine?.quality() ?? null
      })
      this.writeError = null
    }).catch((error) => {
      this.writeError = error
      console.warn('[live] Failed to write live.json:', error)
    })
  }

  private emitUpdate(patch: Omit<LiveUpdate, 'sessionId'>): void {
    this.emit('update', { sessionId: this.options.sessionId, ...patch } satisfies LiveUpdate)
  }
}
