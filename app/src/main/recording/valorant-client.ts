/**
 * Valorant match and round state from the Riot Client's local API (read only, on 127.0.0.1).
 *
 * The Riot Client writes `name:pid:port:password:protocol` to its lockfile; requests use Basic auth `riot:<password>`
 * over HTTPS with the client's self-signed certificate. `/chat/v1/session` names the player (puuid) and
 * `/chat/v4/presences` carries every friend's presence, the player's own included, whose base64 `private` JSON holds
 * the session loop state (MENUS / PREGAME / INGAME) and the party owner's match score. Newer clients nest these under
 * matchPresenceData / partyPresenceData; older ones keep them at the top level. Nothing is written or injected.
 */
import fs from 'fs'
import https from 'https'
import path from 'path'
import { EventEmitter } from 'events'

export interface Lockfile { port: number; password: string }

export interface ValorantPresence {
  state: string
  ally: number
  enemy: number
  queueId: string
}

export type PresenceEvent =
  | { type: 'match_start'; at: number }
  | { type: 'match_end'; at: number }
  | { type: 'round_end'; at: number; winner: 'ally' | 'enemy'; ally: number; enemy: number }

export function lockfilePath(localAppData = process.env.LOCALAPPDATA ?? ''): string {
  return path.join(localAppData, 'Riot Games', 'Riot Client', 'Config', 'lockfile')
}

export function parseLockfile(text: string): Lockfile | null {
  const parts = text.trim().split(':')
  const port = Number(parts[2])
  return parts.length >= 5 && Number.isInteger(port) && port > 0 && port < 65536 && parts[3] ? { port, password: parts[3] } : null
}

/** The player's own Valorant presence from a `/chat/v4/presences` body, or null when absent or unreadable. */
export function ownPresence(body: unknown, puuid: string): ValorantPresence | null {
  const list = (body as { presences?: Array<{ puuid?: string; product?: string; private?: string }> })?.presences
  const me = Array.isArray(list) ? list.find((p) => p.puuid === puuid && p.product === 'valorant') : undefined
  if (!me?.private) return null
  let raw: Record<string, any>
  try { raw = JSON.parse(Buffer.from(me.private, 'base64').toString('utf8')) } catch { return null }
  const match = raw.matchPresenceData ?? raw
  const party = raw.partyPresenceData ?? raw
  const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
  const state = String(match.sessionLoopState ?? raw.sessionLoopState ?? '')
  if (!state) return null
  return {
    state,
    ally: num(party.partyOwnerMatchScoreAllyTeam ?? raw.partyOwnerMatchScoreAllyTeam),
    enemy: num(party.partyOwnerMatchScoreEnemyTeam ?? raw.partyOwnerMatchScoreEnemyTeam),
    queueId: String(match.queueId ?? raw.queueId ?? '')
  }
}

/** Turns successive presences into match and round events. */
export class PresenceTracker {
  private last: ValorantPresence | null = null

  next(p: ValorantPresence, at: number): PresenceEvent[] {
    const prev = this.last
    this.last = p
    const out: PresenceEvent[] = []
    const inGame = p.state === 'INGAME'
    const wasInGame = prev?.state === 'INGAME'
    if (inGame && !wasInGame) out.push({ type: 'match_start', at })
    if (!inGame && wasInGame) out.push({ type: 'match_end', at })
    if (inGame && wasInGame && prev) {
      // The score moves by one per round; anything else (a reconnect, a new match) is not a round end.
      if (p.ally === prev.ally + 1 && p.enemy === prev.enemy) out.push({ type: 'round_end', at, winner: 'ally', ally: p.ally, enemy: p.enemy })
      else if (p.enemy === prev.enemy + 1 && p.ally === prev.ally) out.push({ type: 'round_end', at, winner: 'enemy', ally: p.ally, enemy: p.enemy })
    }
    return out
  }
}

function getJson(lock: Lockfile, route: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: '127.0.0.1', port: lock.port, path: route, method: 'GET', timeout: timeoutMs,
      // The Riot Client's certificate is self-signed and the connection never leaves this machine.
      rejectUnauthorized: false,
      headers: { Authorization: 'Basic ' + Buffer.from(`riot:${lock.password}`).toString('base64') }
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${route}`))
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (error) { reject(error) }
      })
    })
    req.on('timeout', () => req.destroy(new Error(`Timed out reading ${route}`)))
    req.on('error', reject)
    req.end()
  })
}

export interface ValorantClientOptions {
  pollMs?: number
  timeoutMs?: number
  readLockfile?: () => Promise<string>
  fetch?: (lock: Lockfile, route: string) => Promise<unknown>
  now?: () => number
}

/**
 * Polls the local API and emits 'event' (PresenceEvent) and, once, 'unavailable' (Error) when the client cannot be
 * reached; it keeps polling, so events resume if the client comes back.
 */
export class ValorantClient extends EventEmitter {
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private puuid: string | null = null
  private tracker = new PresenceTracker()
  private warned = false

  constructor(private options: ValorantClientOptions = {}) { super() }

  start(): void {
    if (this.running) return
    this.running = true
    void this.poll()
  }

  stop(): void {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** One read of the player's presence without emitting events: whether the client answers at all. */
  async probe(): Promise<boolean> {
    try { return (await this.read()) !== null } catch { return false }
  }

  private async read(): Promise<ValorantPresence | null> {
    const o = this.options
    const lock = parseLockfile(await (o.readLockfile ?? (() => fs.promises.readFile(lockfilePath(), 'utf8')))())
    if (!lock) throw new Error('The Riot Client lockfile is unreadable')
    const fetch = o.fetch ?? ((l: Lockfile, route: string) => getJson(l, route, o.timeoutMs ?? 3000))
    if (!this.puuid) this.puuid = String(((await fetch(lock, '/chat/v1/session')) as { puuid?: string }).puuid ?? '') || null
    if (!this.puuid) throw new Error('The Riot Client has no signed-in player')
    return ownPresence(await fetch(lock, '/chat/v4/presences'), this.puuid)
  }

  private async poll(): Promise<void> {
    const o = this.options
    try {
      const presence = await this.read()
      if (presence && this.running) {
        for (const ev of this.tracker.next(presence, (o.now ?? Date.now)())) this.emit('event', ev)
      }
    } catch (error) {
      this.puuid = null
      if (!this.warned && this.running) {
        this.warned = true
        this.emit('unavailable', error as Error)
      }
    }
    if (this.running) {
      this.timer = setTimeout(() => void this.poll(), o.pollMs ?? 1000)
      this.timer.unref()
    }
  }
}
