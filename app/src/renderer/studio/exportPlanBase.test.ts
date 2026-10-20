import { describe, expect, test } from 'vitest'
import { buildPlanBase } from './exportPlanBase'
import { Project } from '../editor/project'

const project: Project = {
  version: 1,
  name: 'p',
  items: [
    { id: '1', source: 'D:/a.mp4', start: 0, end: 5 },
    { id: '2', source: 'D:/b.mp4', start: 0, end: 5 },
    { id: '3', source: 'D:/b.mp4', start: 6, end: 9 },
    { id: '4', source: 'D:/c.mp4', start: 0, end: 5 }
  ]
}

describe('buildPlanBase', () => {
  test('uses the open video cache for its own source, probes each other source once, tolerates probe failures', async () => {
    const probed: string[] = []
    const base = await buildPlanBase(
      project,
      new Set(['4']),
      { path: 'D:/a.mp4', info: { codec: 'h264', width: 1920, height: 1080 }, keyframes: [0, 2, 4] },
      async (p) => {
        probed.push(p)
        if (p === 'D:/c.mp4') throw new Error('gone')
        return { codec: 'hevc', width: 1280, height: 720, fps: 120, duration: 1 }
      }
    )
    expect(probed).toEqual(['D:/b.mp4']) // Use cache for a; probe b once; do not probe missing source c.
    expect(base.sources['D:/a.mp4']).toEqual({ codec: 'h264', width: 1920, height: 1080 })
    expect(base.sources['D:/b.mp4']).toEqual({ codec: 'hevc', width: 1280, height: 720, fps: 120 })
    expect(base.sources['D:/c.mp4']).toBeUndefined()
    expect(base.keyframes['D:/a.mp4']).toEqual([0, 2, 4])
    expect(base.keyframes['D:/b.mp4']).toBeUndefined()
    expect(base.missingItemIds.has('4')).toBe(true)
  })
})
