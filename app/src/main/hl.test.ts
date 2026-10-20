import { describe, expect, test, vi } from 'vitest'
import { computeHlCount, createHlGuard, createSerialQueue, hlForSavedDoc, hlFromClips } from './hl'
import type { AutoClipParams, CacheDoc } from '../shared/types'

const PARAMS: AutoClipParams = { n: 3, gap: 20, before: 8, after: 4, max_len: 90 }

function makeDoc(): CacheDoc {
  return {
    version: 1,
    video: { path: 'v.mp4', size: 1, mtime: 1, duration: 100, width: 1920, height: 1080, codec: 'h264', start_time: 0 },
    profile: 'zh-TW',
    analysis: { status: 'done', progress_t: 100, engine_version: '0.1.0', templates_version: 'zh-TW@1', h_scale: 1 },
    events: [
      {
        id: 'e1',
        t: 10,
        type: 'knock',
        score: 1,
        damage_line: false,
        name_sig: null,
        counted: true,
        counted_reason: 'first',
        counted_override: null,
        source: 'auto'
      }
    ],
    spectating: [],
    clips: [],
    keyframes: [],
    cache_path: 'C:/cache/x.json'
  }
}

describe('computeHlCount', () => {
  test('never calls analyze: only autoclip on the cached doc, returns clip count', async () => {
    const calls: Array<{ cmd: string; args: Record<string, unknown> }> = []
    const request = vi.fn(async (cmd: string, args: Record<string, unknown>) => {
      calls.push({ cmd, args })
      if (cmd === 'autoclip') return { clips: [{ id: 'c1' }, { id: 'c2' }] }
      return null
    })

    const count = await computeHlCount(request, makeDoc(), PARAMS)
    expect(count).toBe(2)
    expect(calls.map((c) => c.cmd)).toEqual(['autoclip'])
    expect(calls[0].args).toMatchObject({ params: PARAMS, duration: 100 })
    expect(calls[0].args.events).toEqual(makeDoc().events)
  })

  test('no cache doc / unfinished analysis -> skip without any engine call (null)', async () => {
    const request = vi.fn(async () => ({ clips: [] }))
    expect(await computeHlCount(request, null, PARAMS)).toBeNull()
    expect(await computeHlCount(request, { ...makeDoc(), events: undefined } as unknown as CacheDoc, PARAMS)).toBeNull()
    const partial = makeDoc()
    partial.analysis.status = 'partial'
    expect(await computeHlCount(request, partial, PARAMS)).toBeNull()
    expect(request).not.toHaveBeenCalled()
  })

  test('autoclip failure -> null; empty clips -> 0', async () => {
    const failing = vi.fn(async () => {
      throw new Error('engine error')
    })
    expect(await computeHlCount(failing, makeDoc(), PARAMS)).toBeNull()
    const empty = vi.fn(async () => ({ clips: [] }))
    expect(await computeHlCount(empty, makeDoc(), PARAMS)).toBe(0)
  })
})

describe('hlFromClips (studio save / re-analysis refresh) — hl = number of pending suggestions', () => {
  const c = (id: string, status: 'suggested' | 'accepted' | 'skipped', origin: 'ai' | 'manual' = 'ai') => ({
    id,
    start: 0,
    end: 1,
    origin,
    event_ids: [],
    status
  })
  test('counts status === "suggested" ai clips; always a number', () => {
    expect(hlFromClips([c('a', 'suggested'), c('b', 'accepted'), c('d', 'suggested')])).toBe(2)
    expect(hlFromClips([c('a', 'accepted'), c('b', 'skipped')])).toBe(0)
    expect(hlFromClips([c('m', 'accepted', 'manual')])).toBe(0)
    expect(hlFromClips([])).toBe(0)
    expect(hlFromClips(undefined)).toBe(0)
    // Treat legacy files without status as added.
    expect(hlFromClips([{ id: 'x', start: 0, end: 1, origin: 'ai', event_ids: [] }])).toBe(0)
  })

  test('hlForSavedDoc: suggestionsPending => undefined (recompute lazily); otherwise the suggested count', () => {
    expect(hlForSavedDoc({ clips: [c('a', 'suggested')], app: { suggestionsPending: true } })).toBeUndefined()
    expect(hlForSavedDoc({ clips: [c('a', 'suggested')], app: { suggestionsPending: false } })).toBe(1)
    expect(hlForSavedDoc({ clips: [c('a', 'suggested')] })).toBe(1)
  })
})

describe('computeHlCount semantics = pending suggestions', () => {
  const ai = (id: string, start: number, status?: 'suggested' | 'accepted' | 'skipped', stale?: boolean) => ({
    id,
    start,
    end: start + 10,
    origin: 'ai' as const,
    event_ids: [],
    ...(status ? { status } : {}),
    ...(stale ? { stale } : {})
  })

  test('doc with ai clips (no pending flag): counts suggested, no engine call', async () => {
    const request = vi.fn(async () => ({ clips: [] }))
    const doc = { ...makeDoc(), clips: [ai('a', 10, 'suggested'), ai('b', 50, 'accepted'), ai('c', 90, 'suggested')] }
    expect(await computeHlCount(request, doc, PARAMS)).toBe(2)
    expect(request).not.toHaveBeenCalled()
  })

  test('doc without ai clips (manual only): the autoclip count at default params (would be placed as suggestions)', async () => {
    const request = vi.fn(async () => ({ clips: [ai('f1', 10), ai('f2', 80)] }))
    const doc = { ...makeDoc(), clips: [{ id: 'm', start: 300, end: 310, origin: 'manual' as const, event_ids: [], status: 'accepted' as const }] }
    expect(await computeHlCount(request, doc, PARAMS)).toBe(2)
    expect(request).toHaveBeenCalledTimes(1)
  })

  test('pending re-analysis doc: counts what the studio merge will produce (new, non-overlapping suggestions only)', async () => {
    // An existing stale AI clip is at 100; new autoclip results overlap it at 100.3 and add a new clip at 500.
    const request = vi.fn(async () => ({ clips: [ai('f1', 100.3), ai('f2', 500)] }))
    const doc = { ...makeDoc(), clips: [ai('a1', 100, 'accepted', true)], app: { suggestionsPending: true } }
    expect(await computeHlCount(request, doc, PARAMS)).toBe(1)
  })
})

describe('createHlGuard (negative cache + revision counter)', () => {
  test('failed compute is remembered for ~60 s then retried', () => {
    let now = 1_000
    const g = createHlGuard(() => now)
    expect(g.isNegative('k')).toBe(false)
    g.markFailed('k')
    expect(g.isNegative('k')).toBe(true)
    now += 59_999
    expect(g.isNegative('k')).toBe(true)
    now += 2
    expect(g.isNegative('k')).toBe(false)
  })

  test('bump() (a newer authoritative hl) clears the negative entry', () => {
    const g = createHlGuard(() => 0)
    g.markFailed('k')
    g.bump('k')
    expect(g.isNegative('k')).toBe(false)
  })

  test('commitIfCurrent: a compute that started before a cache:save bump cannot overwrite the newer hl', () => {
    const g = createHlGuard()
    const started = g.rev('k')
    const writes: string[] = []
    g.bump('k') // cache:save wrote a newer hl value.
    expect(g.commitIfCurrent('k', started, () => writes.push('stale compute'))).toBe(false)
    expect(writes).toEqual([])
    const fresh = g.rev('k')
    expect(g.commitIfCurrent('k', fresh, () => writes.push('fresh'))).toBe(true)
    expect(writes).toEqual(['fresh'])
  })
})

describe('createSerialQueue', () => {
  test('runs tasks one at a time in FIFO order', async () => {
    const q = createSerialQueue<number>()
    const order: string[] = []
    let running = 0
    let maxRunning = 0
    const task = (name: string, v: number) => async () => {
      running++
      maxRunning = Math.max(maxRunning, running)
      order.push(`start ${name}`)
      await new Promise((r) => setTimeout(r, 5))
      order.push(`end ${name}`)
      running--
      return v
    }
    const res = await Promise.all([q.run('a', task('a', 1)), q.run('b', task('b', 2)), q.run('c', task('c', 3))])
    expect(res).toEqual([1, 2, 3])
    expect(maxRunning).toBe(1)
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
  })

  test('de-duplicates by key while queued or running, allows again afterwards, survives task errors', async () => {
    const q = createSerialQueue<number>()
    const fn = vi.fn(async () => 7)
    const [x, y] = await Promise.all([q.run('k', fn), q.run('k', fn)])
    expect([x, y]).toEqual([7, 7])
    expect(fn).toHaveBeenCalledTimes(1)
    await q.run('k', fn)
    expect(fn).toHaveBeenCalledTimes(2)

    const boom = q.run('bad', async () => {
      throw new Error('x')
    })
    await expect(boom).rejects.toThrow('x')
    expect(await q.run('next', async () => 9)).toBe(9)
    expect(q.size()).toBe(0)
  })
})
