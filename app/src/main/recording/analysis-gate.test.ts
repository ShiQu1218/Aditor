import { afterEach, expect, test, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { createRecordingService } from './index'
import { makeDeps, tempRoot } from './test-support'
import { AnalysisQueue } from '../queue'
import { Library } from '../library'
import type { EngineClient } from '../engine'

vi.mock('../thumbnail', () => ({ generateThumbnail: vi.fn(async () => undefined) }))
afterEach(() => vi.useRealTimers())

test.each(['builtin', 'obs'] as const)('shares game detection with analysis while automatic recording is disabled using %s', async (backend) => {
  vi.useFakeTimers()
  const root = tempRoot()
  const deps = makeDeps(root)
  const settings = { ...deps.getSettings(), autoRecord: false, backend }
  deps.getSettings = () => settings
  const find = vi.fn().mockRejectedValueOnce(new Error('tasklist failed')).mockResolvedValue({ game: 'valorant', pid: 42 })
  deps.findGame = find
  deps.pollMs = 3000
  const request = vi.fn(() => ({ id: 'r', promise: Promise.resolve({ video: { duration: 1 }, events: [] }) }))
  const library = new Library(path.join(root, 'library.json'))
  const file = path.join(root, 'video.mp4')
  library.add([file])
  const queue = new AnalysisQueue({ request, cancel: vi.fn() } as unknown as EngineClient, library,
    { profileDir: root, cacheDir: root, gameRunning: true })
  deps.onGameRunning = (running) => queue.setGameRunning(running)
  const service = createRecordingService(deps)
  try {
    queue.enqueue(file)
    service.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(request).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3000)
    expect(queue.snapshot().waitingForGame).toBe(true)
    find.mockRejectedValueOnce(new Error('tasklist failed'))
    await vi.advanceTimersByTimeAsync(3000)
    expect(queue.snapshot().waitingForGame).toBe(true)
    expect(request).not.toHaveBeenCalled()
    find.mockResolvedValue(null)
    await vi.advanceTimersByTimeAsync(3000)
    expect(request).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3000)
    expect(request).toHaveBeenCalledOnce()
    expect(find).toHaveBeenCalledTimes(5)
    expect(service.status().phase).toBe('idle')
  } finally {
    await service.stop()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
