import { describe, expect, test, vi } from 'vitest'
import type { CacheDoc } from '../../shared/types'
import { loadStudioDoc, type LoaderDeps } from './studioLoader'

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

  test('analyze returns null or non-done: error outcome (never a default doc)', async () => {
    for (const res of [null, doc('partial')]) {
      const d = deps({ cacheLoad: vi.fn(async () => null), analyze: vi.fn(async () => res) })
      const out = await loadStudioDoc('a.mp4', d)
      expect(out.kind).toBe('error')
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
})
