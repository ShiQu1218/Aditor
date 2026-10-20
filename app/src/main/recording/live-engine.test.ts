import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { LiveEngine, mergeIncarnations, parseSnapshot, type LiveSnapshot } from './live-engine'
import { fakeLiveCommand, tempRoot, waitFor } from './test-support'
import type { LiveEvent } from '../../shared/recording'

const roots: string[] = []
const engines: LiveEngine[] = []
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()))
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
function root(): string { const value = tempRoot(); roots.push(value); return value }
function engine(mode: string, env: Record<string, string> = {}, extra: Partial<ConstructorParameters<typeof LiveEngine>[0]> = {}): LiveEngine {
  const value = new LiveEngine({ command: fakeLiveCommand(mode, env), args: ['--shm', 'Local\\aditorrec-x', '--profile-dir', 'p'],
    restartBaseMs: 10, setPriority: () => undefined, ...extra })
  engines.push(value)
  return value
}
const ev = (id: string, t: number): LiveEvent => ({ id, t, type: 'knock', score: 1, damage_line: false, name_sig: null,
  counted: true, counted_reason: 'first', counted_override: null, source: 'auto' })
const traceOf = (file: string): Record<string, unknown>[] => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))

describe('live engine output parsing', () => {
  it('validates snapshot fields: events require id/t/type and spectator intervals must be valid', () => {
    expect(parseSnapshot({ t: 1, events: [ev('a1', 1)], spectating: [{ start: 0, end: 1 }] })).not.toBeNull()
    expect(parseSnapshot({ t: 1, events: [{ id: 'a1', t: -1, type: 'knock' }], spectating: [] })).toBeNull()
    expect(parseSnapshot({ t: 1, events: [{ t: 1, type: 'knock' }], spectating: [] })).toBeNull()
    expect(parseSnapshot({ t: 1, events: [], spectating: [{ start: 2, end: 1 }] })).toBeNull()
    expect(parseSnapshot({ t: 'x', events: [], spectating: [] })).toBeNull()
    expect(parseSnapshot({ t: 1, events: 'x', spectating: [] })).toBeNull()
  })

  it('includes an assessment in the final snapshot and marks merged results after a restart incomplete', () => {
    const final = parseSnapshot({ t: 1, events: [], spectating: [], final: true, quality: { complete: true, reasons: [], h_scale: 1.05 } })
    expect(final?.quality).toEqual({ complete: true, reasons: [], hScale: 1.05 })
    expect(parseSnapshot({ t: 1, events: [], spectating: [], quality: { complete: true } })?.quality).toBeUndefined()
    const merged = mergeIncarnations({ t: 1, events: [], spectating: [] }, final!, 1)
    expect(merged.quality).toEqual({ complete: false, reasons: ['restarted'], hScale: 1.05 })
  })

  it('keeps the game aspect squash the engine analyzed with', () => {
    const quality = { complete: true, reasons: [], h_scale: 1, aspect_squash: 0.75 }
    expect(parseSnapshot({ t: 1, events: [], spectating: [], final: true, quality })?.quality)
      .toEqual({ complete: true, reasons: [], hScale: 1, aspectSquash: 0.75 })
    expect(parseSnapshot({ t: 1, events: [], spectating: [], final: true, quality: { ...quality, aspect_squash: 'x' } })?.quality)
      .not.toHaveProperty('aspectSquash')
  })

  it('merges after restart by keeping all archived data and taking only unique events after the archive time', () => {
    const archived: LiveSnapshot = { t: 10, events: [ev('a1000', 1), ev('a9000', 9)], spectating: [{ start: 2, end: 3 }] }
    const fresh: LiveSnapshot = { t: 20, events: [ev('a5000', 5), ev('a9000', 9), ev('a15000', 15)], spectating: [{ start: 4, end: 5 }, { start: 12, end: 13 }] }
    const merged = mergeIncarnations(archived, fresh, 10)
    expect(merged.events.map((e) => e.id)).toEqual(['a1000', 'a9000', 'a15000'])
    expect(merged.spectating).toEqual([{ start: 2, end: 3 }, { start: 12, end: 13 }])
    expect(merged.t).toBe(20)
    expect(mergeIncarnations(null, fresh, -1)).toBe(fresh)
  })
})

describe('LiveEngine process management', () => {
  it('passes arguments, lowers priority, forwards events, and sends stop while waiting for the final snapshot', async () => {
    const dir = root()
    const trace = path.join(dir, 'trace.jsonl')
    const setPriority = vi.fn()
    const value = engine('normal', { FAKE_LIVE_TRACE: trace }, { setPriority })
    const matches = vi.fn()
    value.on('match', matches)
    value.start()
    await waitFor(() => value.snapshot() !== null)
    expect(value.engineVersion()).toBe('0.3.0')
    expect(setPriority).toHaveBeenCalledWith(expect.any(Number))
    expect(matches).toHaveBeenCalledWith({ ev: 'match_start', t: 0.5, reason: 'countdown' })
    expect(value.snapshot()!.events.map((e) => e.id)).toEqual(['a1000'])
    await value.stop()
    expect(value.snapshot()!.events.map((e) => e.id)).toEqual(['a1000', 'a3500'])
    expect(matches).toHaveBeenLastCalledWith({ ev: 'match_end', t: 3.5, reason: 'lobby' })
    const lines = traceOf(trace)
    expect(lines[0]).toEqual({ argv: ['--shm', 'Local\\aditorrec-x', '--profile-dir', 'p'] })
    expect(lines).toContainEqual({ stdin: '{"cmd":"stop"}' })
  })

  it('restarts with backoff after a crash and preserves events from before the restart', async () => {
    const dir = root()
    const trace = path.join(dir, 'trace.jsonl')
    const value = engine('crash-once', { FAKE_LIVE_TRACE: trace, FAKE_LIVE_STATE: path.join(dir, 'state') })
    const restarting = vi.fn()
    value.on('restarting', restarting)
    value.start()
    await waitFor(() => restarting.mock.calls.length === 1 && (value.snapshot()?.events.length ?? 0) >= 2)
    expect(restarting.mock.calls[0][0].delayMs).toBe(10)
    // The new process's event at t=0.5 predates the seal time (last seen at t=2), so discard it; keep a3000.
    expect(value.snapshot()!.events.map((e) => e.id)).toEqual(['a1000', 'a3000'])
    expect(value.snapshot()!.spectating).toEqual([{ start: 0.2, end: 0.4 }])
    await value.stop()
    expect(value.snapshot()!.events.map((e) => e.id)).toEqual(['a1000', 'a3000', 'a3500'])
    expect(value.snapshot()!.spectating).toEqual([{ start: 0.2, end: 0.4 }, { start: 3.6, end: 3.9 }])
    expect(traceOf(trace).filter((line) => line.argv)).toHaveLength(2)
  })

  it('gives up and reports after 5 restarts within 10 minutes without starting again', async () => {
    const value = new LiveEngine({ command: { command: process.execPath, args: ['-e', 'process.exit(2)'] }, args: [], restartBaseMs: 1, setPriority: () => undefined })
    engines.push(value)
    const failed = vi.fn()
    const restarting = vi.fn()
    value.on('failed', failed)
    value.on('restarting', restarting)
    value.start()
    await waitFor(() => failed.mock.calls.length === 1)
    expect(restarting).toHaveBeenCalledTimes(5)
    expect(restarting.mock.calls.map(([info]) => info.delayMs)).toEqual([1, 2, 4, 8, 16])
    expect(String(failed.mock.calls[0][0].message)).toContain('錄影不受影響')
  })

  it('ignores malformed lines and force-terminates after a stop timeout', async () => {
    const garbage = engine('garbage')
    const warning = vi.fn()
    garbage.on('warning', warning)
    garbage.start()
    await waitFor(() => garbage.snapshot() !== null)
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('JSON'))
    const stuck = engine('never-stop', {}, { stopTimeoutMs: 100 })
    stuck.start()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const started = performance.now()
    await stuck.stop()
    expect(performance.now() - started).toBeLessThan(3000)
  })
})

it.each(['match_pending', 'match_cancel'])('Parse and validate new match events: %s', (ev) => {
  const live = engine('normal')
  const listener = vi.fn()
  live.on('match', listener)
  for (const t of [-1, null, '1']) (live as any).onLine(JSON.stringify({ ev, t, reason: '測試' }))
  expect(listener).not.toHaveBeenCalled()
  ;(live as any).onLine(JSON.stringify({ ev, t: 1, reason: '測試' }))
  expect(listener).toHaveBeenCalledWith({ ev, t: 1, reason: '測試' })
})

it('reports analysis progress only when stats include processed frames, ignoring unprocessed or malformed stats', () => {
  const live = engine('normal')
  const listener = vi.fn()
  live.on('progress', listener)
  ;(live as any).onLine(JSON.stringify({ ev: 'stats', t: 0, frames: 0 }))
  ;(live as any).onLine(JSON.stringify({ ev: 'stats', t: 'x', frames: 3 }))
  ;(live as any).onLine(JSON.stringify({ ev: 'stats', t: 5, frames: '3' }))
  expect(listener).not.toHaveBeenCalled()
  ;(live as any).onLine(JSON.stringify({ ev: 'stats', t: 12.5, frames: 50 }))
  expect(listener).toHaveBeenCalledWith(12.5)
})
