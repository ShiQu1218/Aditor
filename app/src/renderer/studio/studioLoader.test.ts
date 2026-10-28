import { describe, expect, test, vi } from 'vitest'
import type { CacheDoc } from '../../shared/types'
import { loadStudioDoc, type LoaderDeps } from './studioLoader'
import type { VideoInfo } from '../../shared/types'

const doc = (status: string): CacheDoc =>
  ({ version: 1, video: { path: 'a', duration: 50 }, analysis: { status }, events: [], spectating: [], clips: [] }) as unknown as CacheDoc

function deps(over: Partial<LoaderDeps> = {}): LoaderDeps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    getStatus: vi.fn(async () => {
      calls.push('status')
      return 'done'
    }),
    cacheLoad: vi.fn(async () => {
      calls.push('cache')
      return doc('done')
    }),
    analyze: vi.fn(async () => {
      calls.push('analyze')
      return doc('done')
    }),
    ...over
  } as LoaderDeps & { calls: string[] }
}

describe('loadStudioDoc', () => {
  test('project source without cache opens a real empty timeline without starting another analysis', async () => {
    const d = deps({ getStatus: async () => 'analyzing', cacheLoad: async () => null, probe: vi.fn(async () => ({ path: 'b', duration: 123 }) as VideoInfo) })
    const out = await loadStudioDoc('b', d, true)
    expect(out).toMatchObject({ kind: 'ready', from: 'metadata', doc: { video: { path: 'b', duration: 123 }, analysis: { status: 'partial' }, events: [], clips: [] } })
    expect(d.analyze).not.toHaveBeenCalled()
  })

  test('project source uses an existing cache even while queued', async () => {
    const d = deps({ getStatus: async () => 'pending' })
    expect(await loadStudioDoc('b', d, true)).toMatchObject({ kind: 'ready', from: 'cache' })
    expect(d.analyze).not.toHaveBeenCalled()
  })

  test.each([0, -1, NaN, Infinity])('project source rejects invalid metadata duration %s', async (duration) => {
    const d = deps({ cacheLoad: async () => null, probe: async () => ({ duration }) as VideoInfo })
    expect(await loadStudioDoc('b', d, true)).toMatchObject({ kind: 'error' })
    expect(d.analyze).not.toHaveBeenCalled()
  })

  test('entry done + cache hit: cache only, analyze never called', async () => {
    const d = deps()
    const out = await loadStudioDoc('a.mp4', d)
    expect(out.kind).toBe('ready')
    expect(d.calls).toEqual(['status', 'cache'])
  })

  test.each(['pending', 'analyzing', 'error', null])('entry %s: blocked before ANY engine/cache call', async (status) => {
    const d = deps({ getStatus: vi.fn(async () => status as never) })
    const out = await loadStudioDoc('a.mp4', d)
    expect(out.kind).toBe('blocked')
    expect(d.cacheLoad).not.toHaveBeenCalled()
    expect(d.analyze).not.toHaveBeenCalled()
  })

  test('done entry without cache document: falls back to analyze, then ready', async () => {
    const d = deps({ cacheLoad: vi.fn(async () => null) })
    const out = await loadStudioDoc('a.mp4', d)
    expect(out.kind).toBe('ready')
    expect(d.analyze).toHaveBeenCalledTimes(1)
  })

  test('cache doc that is not done is blocked (analyze not called)', async () => {
    const d = deps({ cacheLoad: vi.fn(async () => doc('partial')) })
    const out = await loadStudioDoc('a.mp4', d)
    expect(out.kind).toBe('blocked')
    expect(d.analyze).not.toHaveBeenCalled()
  })

  test('queued analysis is blocked and a non-done result is an error', async () => {
    for (const res of [null, doc('partial')]) {
      const d = deps({ cacheLoad: vi.fn(async () => null), analyze: vi.fn(async () => res) })
      const out = await loadStudioDoc('a.mp4', d)
      expect(out.kind).toBe(res ? 'error' : 'blocked')
    }
  })

  test('thrown errors become error outcome carrying code and message', async () => {
    const err = Object.assign(new Error('boom'), { code: 3 })
    const d = deps({ cacheLoad: vi.fn(async () => { throw err }) })
    const out = await loadStudioDoc('a.mp4', d)
    expect(out).toEqual({ kind: 'error', message: 'boom', code: 3 })
  })

  test('getStatus throwing is an error outcome too', async () => {
    const d = deps({ getStatus: vi.fn(async () => { throw new Error('ipc down') }) })
    expect((await loadStudioDoc('a.mp4', d)).kind).toBe('error')
  })

  test('probe returning null explains the file could not be probed', async () => {
    const d = deps({ cacheLoad: async () => null, probe: async () => null })
    expect(await loadStudioDoc('b', d, true)).toMatchObject({ kind: 'error', message: expect.stringContaining('could not be probed') })
  })

  test('invalid probe duration is reported in the message', async () => {
    const d = deps({ cacheLoad: async () => null, probe: async () => ({ duration: 0 }) as VideoInfo })
    expect(await loadStudioDoc('b', d, true)).toMatchObject({ kind: 'error', message: expect.stringContaining('duration 0') })
  })

  test('unusable analysis reports its status and queued analysis stays blocked', async () => {
    const partial = deps({ cacheLoad: async () => null, analyze: async () => doc('partial') })
    expect(await loadStudioDoc('a', partial)).toMatchObject({ kind: 'error', message: expect.stringContaining('status: partial') })
    const none = deps({ cacheLoad: async () => null, analyze: async () => null })
    expect(await loadStudioDoc('a', none)).toEqual({ kind: 'blocked' })
  })

  test('non-Error throws are stringified once', async () => {
    const d = deps({ getStatus: async () => { throw 'oops' } })
    expect(await loadStudioDoc('a', d)).toEqual({ kind: 'error', message: 'Loading failed: oops' })
  })
})
