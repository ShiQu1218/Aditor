import { describe, it, expect, beforeEach } from 'vitest'
import { AnalysisQueue } from './queue'
import { Library } from './library'
import { EngineClient } from './engine'
import path from 'path'
import os from 'os'

describe('AnalysisQueue', () => {
  let tmpFile: string
  let lib: Library

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `apexhl_queue_test_${Date.now()}_${Math.random()}.json`)
    lib = new Library(tmpFile)
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
})
