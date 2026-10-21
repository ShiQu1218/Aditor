import { describe, expect, it, vi } from 'vitest'
import { PresenceTracker, ValorantClient, ownPresence, parseLockfile, type PresenceEvent } from './valorant-client'

const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64')
const presences = (puuid: string, priv: object) => ({ presences: [
  { puuid: 'friend', product: 'valorant', private: encode({ sessionLoopState: 'INGAME' }) },
  { puuid, product: 'league_of_legends', private: '' },
  { puuid, product: 'valorant', private: encode(priv) }] })

describe('Riot Client local API', () => {
  it('reads the lockfile port and password', () => {
    expect(parseLockfile('Riot Client:1234:10218:s3cret:https')).toEqual({ port: 10218, password: 's3cret' })
    expect(parseLockfile('garbage')).toBeNull()
  })

  it('reads the player own presence in the nested and the older flat format', () => {
    const nested = { matchPresenceData: { sessionLoopState: 'INGAME', queueId: 'competitive' },
      partyPresenceData: { partyOwnerMatchScoreAllyTeam: 3, partyOwnerMatchScoreEnemyTeam: 5 } }
    expect(ownPresence(presences('me', nested), 'me')).toEqual({ state: 'INGAME', ally: 3, enemy: 5, queueId: 'competitive' })
    const flat = { sessionLoopState: 'MENUS', partyOwnerMatchScoreAllyTeam: 0, partyOwnerMatchScoreEnemyTeam: 0, queueId: 'unrated' }
    expect(ownPresence(presences('me', flat), 'me')).toEqual({ state: 'MENUS', ally: 0, enemy: 0, queueId: 'unrated' })
    expect(ownPresence(presences('me', flat), 'someone-else')).toBeNull()
  })

  it('turns presence changes into match and round events', () => {
    const tr = new PresenceTracker()
    const p = (state: string, ally = 0, enemy = 0) => ({ state, ally, enemy, queueId: 'competitive' })
    const seq = [p('MENUS'), p('PREGAME'), p('INGAME'), p('INGAME', 1, 0), p('INGAME', 1, 1), p('INGAME', 1, 1), p('INGAME', 4, 4), p('MENUS', 4, 4)]
    const events = seq.flatMap((x, i) => tr.next(x, i))
    expect(events).toEqual([
      { type: 'match_start', at: 2 },
      { type: 'round_end', at: 3, winner: 'ally', ally: 1, enemy: 0 },
      { type: 'round_end', at: 4, winner: 'enemy', ally: 1, enemy: 1 },
      { type: 'match_end', at: 7 }])  // A jump of several rounds (a reconnect) is not a round end.
  })

  it('polls the client, emits events and reports an unreachable client once', async () => {
    vi.useFakeTimers()
    let state = 'MENUS'
    let fail = true
    const client = new ValorantClient({
      pollMs: 100, readLockfile: async () => 'Riot Client:1:10218:pw:https', now: () => 42,
      fetch: async (_lock, route) => {
        if (fail) throw new Error('connect ECONNREFUSED')
        return route === '/chat/v1/session' ? { puuid: 'me' } : presences('me', { sessionLoopState: state })
      }
    })
    const events: PresenceEvent[] = []
    const unavailable = vi.fn()
    client.on('event', (e: PresenceEvent) => events.push(e))
    client.on('unavailable', unavailable)
    client.start()
    await vi.advanceTimersByTimeAsync(250)
    expect(unavailable).toHaveBeenCalledOnce()
    fail = false
    await vi.advanceTimersByTimeAsync(100)
    state = 'INGAME'
    await vi.advanceTimersByTimeAsync(100)
    expect(events).toEqual([{ type: 'match_start', at: 42 }])
    client.stop()
    vi.useRealTimers()
  })
})
