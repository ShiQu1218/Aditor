import { describe, expect, test, vi } from 'vitest'
import { createFakeApi } from '../../../test/fakeApi'
import type { LibraryEntry } from '../../main/library'
import { importExternalVideos } from './externalVideos'

const entry = (path: string, status: LibraryEntry['status'], durationSec?: number): LibraryEntry => ({ path, status, durationSec, addedAt: 0, favorite: false, progress: 0 })

describe('importExternalVideos', () => {
  test('preserves selection order, deduplicates paths, and probes each full duration', async () => {
    const probe = vi.fn(async (path: string) => ({ duration: path.includes('a') ? 120 : 240 }))
    const { api } = createFakeApi({ overrides: { engine: { probe } } })
    const out = await importExternalVideos(['D:/a.mp4', 'D:/b.mp4', 'd:\\a.mp4'], api)
    expect(out.items).toEqual([{ source: 'd:\\a.mp4', start: 0, end: 120 }, { source: 'D:/b.mp4', start: 0, end: 240 }])
    expect(out.failed).toEqual([])
    expect(probe).toHaveBeenCalledTimes(2)
    expect(api.queue.enqueue).toHaveBeenCalledTimes(2)
    expect(api.library.add.mock.invocationCallOrder[0]).toBeLessThan(api.queue.enqueue.mock.invocationCallOrder[0])
  })

  test('done, analyzing, and queued sources are not reanalyzed; cached library durations avoid probing', async () => {
    const { api } = createFakeApi({
      entries: [entry('d:/done.mp4', 'done', 10), entry('d:/running.mp4', 'analyzing', 20), entry('d:/queued.mp4', 'pending', 30)],
      overrides: { queue: { getState: async () => ({ queue: { analyzing: 'd:/running.mp4', queued: ['d:/queued.mp4'] }, current: null }) } }
    })
    const out = await importExternalVideos(['D:\\done.mp4', 'd:/running.mp4', 'd:/queued.mp4'], api)
    expect(out.items.map((i) => i.end)).toEqual([10, 20, 30])
    expect(api.queue.enqueue).not.toHaveBeenCalled()
    expect(api.engine.probe).not.toHaveBeenCalled()
  })

  test('one failed probe retains library imports and the other clips', async () => {
    const { api } = createFakeApi({ overrides: { engine: { probe: async (path: string) => { if (path === 'bad') throw new Error('probe'); return { duration: 42 } } } } })
    const out = await importExternalVideos(['bad', 'good'], api)
    expect(api.library.add).toHaveBeenCalledWith(['bad', 'good'])
    expect(api.library.remove).not.toHaveBeenCalled()
    expect(out).toEqual({ items: [{ source: 'good', start: 0, end: 42 }], failed: ['bad'] })
  })

  test.each([0, -1, NaN, Infinity])('invalid duration %s produces no project clip', async (duration) => {
    const { api } = createFakeApi({ overrides: { engine: { probe: async () => ({ duration }) } } })
    expect(await importExternalVideos(['bad'], api)).toEqual({ items: [], failed: ['bad'] })
  })

  test('enqueue failure is reported while a valid video remains editable', async () => {
    const { api } = createFakeApi({ overrides: { engine: { probe: async () => ({ duration: 42 }) }, queue: { enqueue: async () => { throw new Error('queue') } } } })
    expect(await importExternalVideos(['video'], api)).toEqual({ items: [{ source: 'video', start: 0, end: 42 }], failed: ['video'] })
  })
})
