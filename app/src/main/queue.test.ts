import { describe, it, expect, beforeEach, vi } from 'vitest'
import { AnalysisQueue } from './queue'
import { Library } from './library'
import { EngineClient, EngineError } from './engine'
import path from 'path'
import os from 'os'

async function waitFor(condition: () => boolean, timeout = 2000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for test condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('AnalysisQueue', () => {
  let tmpFile: string
  let lib: Library

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `aditor_queue_test_${Date.now()}_${Math.random()}.json`)
    lib = new Library(tmpFile)
  })

  it('asks the user for the game when the engine cannot recognise it, then analyzes with the chosen game', async () => {
    const calls: Array<{ game?: string }> = []
    const engineMock = {
      request: (_cmd: string, args: { path: string; game?: string }) => {
        calls.push({ game: args.game })
        const promise = args.game
          ? Promise.resolve({ game: args.game, video: { duration: 10 }, events: [
            { id: 'v1', t: 1, type: 'kill', counted: true, counted_override: null },
            { id: 'v2', t: 2, type: 'death', counted: true, counted_override: null }] })
          : Promise.reject(new EngineError('unknown_game', 'Could not recognise the game'))
        return { id: `req_${calls.length}`, promise }
      },
      cancel: () => {}
    } as unknown as EngineClient

    const video = 'D:/Videos/vod.mp4'
    lib.add([video])
    const queue = new AnalysisQueue(engineMock, lib, { profileDir: '/profile', cacheDir: '/cache' })
    queue.enqueue(video)
    await new Promise((r) => setTimeout(r, 20))
    expect(calls).toEqual([{ game: undefined }])
    expect(lib.get(video)).toMatchObject({ status: 'error', errorCode: 'unknown_game' })

    // What library:setGame does: record the choice and queue the video again.
    lib.update(video, { game: 'valorant', status: 'pending', error: undefined, errorCode: undefined })
    queue.enqueue(video)
    await new Promise((r) => setTimeout(r, 20))
    expect(calls[1]).toEqual({ game: 'valorant' })
    expect(lib.get(video)).toMatchObject({ status: 'done', game: 'valorant', counts: { knock: 0, assist: 0, kill: 1, death: 1 } })
    expect(lib.get(video)?.errorCode).toBeUndefined()
  })

  it('queue runs one analyze at a time', async () => {
    const activeRequests: string[] = []
    const engineMock = {
      request: (cmd: string, args: { path: string }) => {
        activeRequests.push(args.path)
        let resolveReq!: (v: unknown) => void
        const promise = new Promise((resolve) => {
          resolveReq = resolve
        })
        setTimeout(() => {
          activeRequests.splice(activeRequests.indexOf(args.path), 1)
          resolveReq({
            video: { duration: 100 },
            events: []
          })
        }, 30)
        return { id: 'req_1', promise }
      },
      cancel: () => {}
    } as unknown as EngineClient

    lib.add(['D:/Videos/v1.mp4', 'D:/Videos/v2.mp4'])
    const queue = new AnalysisQueue(engineMock, lib, {
      profileDir: '/profile',
      cacheDir: '/cache'
    })

    queue.enqueue('D:/Videos/v1.mp4')
    queue.enqueue('D:/Videos/v2.mp4')

    // At first only v1 should be running
    expect(activeRequests).toEqual(['D:/Videos/v1.mp4'])
    expect(lib.getEntries().find((e) => e.path === 'D:/Videos/v1.mp4')?.status).toBe('analyzing')
    expect(lib.getEntries().find((e) => e.path === 'D:/Videos/v2.mp4')?.status).toBe('pending')

    // Wait for both to finish
    await new Promise((r) => setTimeout(r, 100))
    expect(lib.getEntries().find((e) => e.path === 'D:/Videos/v1.mp4')?.status).toBe('done')
    expect(lib.getEntries().find((e) => e.path === 'D:/Videos/v2.mp4')?.status).toBe('done')
  })

  it('queue continues after failure', async () => {
    const engineMock = {
      request: (_cmd: string, args: { path: string }) => {
        if (args.path.includes('fail')) {
          return {
            id: 'err_1',
            promise: Promise.reject(new Error('probe_failed'))
          }
        }
        return {
          id: 'ok_1',
          promise: Promise.resolve({
            video: { duration: 60 },
            events: []
          })
        }
      },
      cancel: () => {}
    } as unknown as EngineClient

    lib.add(['D:/Videos/fail.mp4', 'D:/Videos/success.mp4'])
    const queue = new AnalysisQueue(engineMock, lib, {
      profileDir: '/profile',
      cacheDir: '/cache'
    })

    queue.enqueue('D:/Videos/fail.mp4')
    queue.enqueue('D:/Videos/success.mp4')

    await new Promise((r) => setTimeout(r, 50))

    const failEntry = lib.getEntries().find((e) => e.path === 'D:/Videos/fail.mp4')
    const okEntry = lib.getEntries().find((e) => e.path === 'D:/Videos/success.mp4')

    expect(failEntry?.status).toBe('error')
    expect(failEntry?.error).toBe('probe_failed')
    expect(okEntry?.status).toBe('done')
  })

  it('counts use final counted flag', async () => {
    const events = [
      { id: '1', t: 10, type: 'knock', counted: true, counted_override: null, damage_line: true },
      { id: '2', t: 20, type: 'knock', counted: true, counted_override: false, damage_line: true }, // overridden to false
      { id: '3', t: 30, type: 'knock', counted: false, counted_override: true, damage_line: true }, // overridden to true
      { id: '4', t: 40, type: 'knock', counted: true, counted_override: null, deleted: true, damage_line: true }, // deleted
      { id: '5', t: 50, type: 'assist_knock', counted: true, counted_override: null, damage_line: false },
      { id: '6', t: 60, type: 'assist_elim', counted: true, counted_override: null, damage_line: false },
      { id: '7', t: 70, type: 'squad_wipe', counted: false, counted_override: null, damage_line: false }
    ]

    const engineMock = {
      request: () => {
        return {
          id: 'ok',
          promise: Promise.resolve({
            video: { duration: 100 },
            events
          })
        }
      },
      cancel: () => {}
    } as unknown as EngineClient

    lib.add(['D:/Videos/test_counts.mp4'])
    const queue = new AnalysisQueue(engineMock, lib, {
      profileDir: '/profile',
      cacheDir: '/cache'
    })

    queue.enqueue('D:/Videos/test_counts.mp4')
    await new Promise((r) => setTimeout(r, 50))

    const entry = lib.getEntries().find((e) => e.path === 'D:/Videos/test_counts.mp4')
    expect(entry?.status).toBe('done')
    // knock: 1 and 3 are counted (total 2)
    // assist: 5 (assist_knock) + 6 (assist_elim) = 2
    expect(entry?.counts).toEqual({ knock: 2, assist: 2 })
  })
  it('completed (re-)analysis invalidates the cached hl count', async () => {
    const engineMock = {
      request: () => ({ id: 'r', promise: Promise.resolve({ video: { duration: 10 }, events: [] }) }),
      cancel: () => {}
    } as unknown as EngineClient
    lib.add(['D:/Videos/h.mp4'])
    lib.update('D:/Videos/h.mp4', { status: 'done', hl: 5 })
    const queue = new AnalysisQueue(engineMock, lib, { profileDir: '/profile', cacheDir: '/cache' })
    queue.enqueue('D:/Videos/h.mp4')
    await new Promise((r) => setTimeout(r, 50))
    const e = lib.getEntries().find((x) => x.path === 'D:/Videos/h.mp4')
    expect(e?.status).toBe('done')
    expect(e?.hl).toBeUndefined()
  })
})

describe('AnalysisQueue settings wiring (decode/cacheLocation)', () => {
  function run(settings: { decode: 'auto' | 'software'; cacheLocation: 'appdata' | 'besideVideo' } | undefined) {
    const seen: Array<Record<string, unknown>> = []
    const engineMock = {
      request: (_cmd: string, args: Record<string, unknown>) => {
        seen.push(args)
        return { id: 'r', promise: Promise.resolve({ video: { duration: 10 }, events: [], analysis: { status: 'done' } }) }
      },
      cancel: () => {}
    } as unknown as EngineClient
    const file = path.join(os.tmpdir(), `aditor_queue_set_${Date.now()}_${Math.random()}.json`)
    const lib = new Library(file)
    lib.add(['D:/Videos/s.mp4'])
    const queue = new AnalysisQueue(engineMock, lib, {
      profileDir: '/p',
      cacheDir: '/c',
      getSettings: settings ? () => settings : undefined
    })
    queue.enqueue('D:/Videos/s.mp4')
    return { seen, queue }
  }

  it('decode=software → hwaccel:false；cacheLocation=besideVideo → beside:true', async () => {
    const { seen } = run({ decode: 'software', cacheLocation: 'besideVideo' })
    await new Promise((r) => setTimeout(r, 30))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ hwaccel: false, beside: true, cache_dir: '/c' })
  })

  it('defaults to hwaccel:true and beside:false when settings are missing; reads settings on every request (no restart required)', async () => {
    const { seen } = run(undefined)
    await new Promise((r) => setTimeout(r, 30))
    expect(seen[0]).toMatchObject({ hwaccel: true, beside: false })

    let cur: { decode: 'auto' | 'software'; cacheLocation: 'appdata' | 'besideVideo' } = { decode: 'auto', cacheLocation: 'appdata' }
    const seen2: Array<Record<string, unknown>> = []
    const engineMock = {
      request: (_c: string, a: Record<string, unknown>) => {
        seen2.push(a)
        return { id: 'r', promise: Promise.resolve({ video: { duration: 1 }, events: [] }) }
      },
      cancel: () => {}
    } as unknown as EngineClient
    const lib = new Library(path.join(os.tmpdir(), `aditor_queue_set2_${Date.now()}.json`))
    lib.add(['D:/Videos/a.mp4', 'D:/Videos/b.mp4'])
    const q = new AnalysisQueue(engineMock, lib, { profileDir: '/p', cacheDir: '/c', getSettings: () => cur })
    q.enqueue('D:/Videos/a.mp4')
    await new Promise((r) => setTimeout(r, 30))
    cur = { decode: 'software', cacheLocation: 'besideVideo' }
    q.enqueue('D:/Videos/b.mp4')
    await new Promise((r) => setTimeout(r, 30))
    expect(seen2.map((a) => [a.hwaccel, a.beside])).toEqual([
      [true, false],
      [false, true]
    ])
  })
})

describe('AnalysisQueue game aspect', () => {
  it('leaves aspect resolution to the engine instead of reading the current Apex config', async () => {
    const lib = new Library(path.join(os.tmpdir(), `aditor_queue_aspect_${Date.now()}_${Math.random()}.json`))
    const seen: Record<string, unknown>[] = []
    const engineMock = {
      request: (_cmd: string, args: Record<string, unknown>) => {
        seen.push(args)
        return { id: 'r', promise: Promise.resolve({ video: { duration: 10 }, events: [] }) }
      },
      cancel: () => {}
    } as unknown as EngineClient
    lib.add(['D:/Videos/a.mp4', 'D:/Videos/b.mp4'])
    let aspect: string | null = '1920x1440'
    const getGameAspect = vi.fn(() => aspect)
    const options = { profileDir: '/profile', cacheDir: '/cache', getGameAspect }
    const queue = new AnalysisQueue(engineMock, lib, options)
    queue.enqueue('D:/Videos/a.mp4')
    await new Promise((r) => setTimeout(r, 20))
    aspect = null
    queue.enqueue('D:/Videos/b.mp4')
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toHaveLength(2)
    expect(seen[0]).not.toHaveProperty('aspect')
    expect(seen[1]).not.toHaveProperty('aspect')
    expect(getGameAspect).not.toHaveBeenCalled()
  })

  it('passes force only for an explicit reanalysis', async () => {
    const forces: unknown[] = []
    const engineMock = {
      request: (_cmd: string, args: { force?: boolean }) => {
        forces.push(args.force)
        return { id: `req_${forces.length}`, promise: Promise.resolve({ video: { duration: 10 }, events: [] }) }
      },
      cancel: () => {}
    } as unknown as EngineClient
    const video = 'D:/Videos/again.mp4'
    const lib = new Library(path.join(os.tmpdir(), `aditor_queue_force_${Date.now()}_${Math.random()}.json`))
    lib.add([video])
    const queue = new AnalysisQueue(engineMock, lib, { profileDir: '/profile', cacheDir: '/cache' })
    queue.enqueue(video)
    await waitFor(() => forces.length === 1)
    await waitFor(() => queue.snapshot().analyzing === null)
    queue.enqueue(video, true)
    await waitFor(() => forces.length === 2)
    await waitFor(() => queue.snapshot().analyzing === null)
    queue.enqueue(video)
    await waitFor(() => forces.length === 3)
    await waitFor(() => queue.snapshot().analyzing === null)
    expect(forces).toEqual([undefined, true, undefined])
  })

  it('does not leak a force request made while the video is already running', async () => {
    const forces: Array<boolean | undefined> = []
    const finish: Array<() => void> = []
    const engineMock = {
      request: (_cmd: string, args: { force?: boolean }) => {
        forces.push(args.force)
        const promise = new Promise<unknown>((resolve) => {
          finish.push(() => resolve({ video: { duration: 10 }, events: [] }))
        })
        return { id: `req_${forces.length}`, promise }
      },
      cancel: () => {}
    } as unknown as EngineClient
    const video = 'D:/Videos/running.mp4'
    const lib = new Library(path.join(os.tmpdir(), `aditor_queue_force_running_${Date.now()}_${Math.random()}.json`))
    lib.add([video])
    const queue = new AnalysisQueue(engineMock, lib, { profileDir: '/profile', cacheDir: '/cache' })

    queue.enqueue(video)
    await waitFor(() => finish.length === 1)
    // Already running, so nothing is queued for this path and the force request must not be remembered.
    queue.enqueue(video, true)
    expect(forces).toEqual([undefined])

    finish[0]()
    await waitFor(() => queue.snapshot().analyzing === null)
    queue.enqueue(video)
    await waitFor(() => finish.length === 2)
    finish[1]()
    await waitFor(() => queue.snapshot().analyzing === null)
    expect(forces).toEqual([undefined, undefined])
  })
})
