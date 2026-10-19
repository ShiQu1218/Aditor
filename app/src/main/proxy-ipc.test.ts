import { describe, it, expect, vi } from 'vitest'
import { handleProxyGenerate, handleProxyUsage, parseProxyDuration } from './proxy-ipc'

function fakeSender(destroyed = false) {
  const sent: Array<{ channel: string; data: { videoPath: string; ratio: number } }> = []
  return {
    sent,
    destroyed,
    isDestroyed() {
      return this.destroyed
    },
    send(channel: string, data: { videoPath: string; ratio: number }) {
      sent.push({ channel, data })
    }
  }
}

describe('parseProxyDuration', () => {
  it('accepts only finite positive numbers', () => {
    expect(parseProxyDuration(120)).toBe(120)
    for (const bad of [0, -1, NaN, Infinity, '12', undefined, null]) {
      expect(parseProxyDuration(bad)).toBeUndefined()
    }
  })
})

describe('handleProxyGenerate', () => {
  it('forwards progress and throttles updates (>=250ms), then sends 1 on completion', async () => {
    const s = fakeSender()
    let now = 1000
    const gen = vi.fn(async (_p: string, onProgress?: (r: number) => void, _d?: number) => {
      onProgress?.(0.1) // Sent immediately.
      now += 100
      onProgress?.(0.2) // Throttled.
      now += 200
      onProgress?.(0.3) // Sent 300 ms after the previous update.
      now += 10
      onProgress?.(1) // Always send the completion update.
      return 'out.mp4'
    })
    const r = await handleProxyGenerate(s, 'D:/v/a.mp4', 60, { generateProxy: gen, now: () => now })
    expect(r).toBe('out.mp4')
    expect(gen.mock.calls[0][2]).toBe(60)
    expect(s.sent.map((m) => m.data.ratio)).toEqual([0.1, 0.3, 1])
    expect(s.sent.every((m) => m.channel === 'proxy:progress' && m.data.videoPath === 'D:/v/a.mp4')).toBe(true)
  })

  it('does not send after the window is destroyed', async () => {
    const s = fakeSender(true)
    const gen = async (_p: string, on?: (r: number) => void) => {
      on?.(0.5)
      return 'o'
    }
    await handleProxyGenerate(s, 'D:/v/a.mp4', 60, { generateProxy: gen, now: () => 0 })
    expect(s.sent).toEqual([])
  })

  it('a send exception (window destroyed mid-send) does not affect the result', async () => {
    const s = fakeSender()
    s.send = () => {
      throw new Error('Object has been destroyed')
    }
    const gen = async (_p: string, on?: (r: number) => void) => {
      on?.(0.5)
      return 'o'
    }
    await expect(handleProxyGenerate(s, 'D:/v/a.mp4', 60, { generateProxy: gen, now: () => 0 })).resolves.toBe('o')
  })

  it('passes undefined duration to generateProxy when invalid (no percentage)', async () => {
    const s = fakeSender()
    const gen = vi.fn(async (_p: string, _o?: (r: number) => void, _d?: number) => 'o')
    await handleProxyGenerate(s, 'D:/v/a.mp4', NaN, { generateProxy: gen, now: () => 0 })
    expect(gen.mock.calls[0][2]).toBeUndefined()
  })

  it('propagates errors and sends no progress after failure', async () => {
    const s = fakeSender()
    let late: ((r: number) => void) | undefined
    const gen = async (_p: string, on?: (r: number) => void) => {
      late = on
      throw new Error('ffmpeg failed')
    }
    await expect(handleProxyGenerate(s, 'D:/v/a.mp4', 60, { generateProxy: gen, now: () => 0 })).rejects.toThrow('ffmpeg failed')
    late?.(0.9)
    expect(s.sent).toEqual([])
  })

  it('rejects unsafe paths (URL/concat:/UNC/non-video extension) without calling ffmpeg (Minor 13)', async () => {
    for (const bad of ['http://x/a.mp4', 'concat:a|b', '\\\\srv\\s\\a.mp4', 'D:/v/a.exe', 'a.mp4']) {
      let called = false
      await expect(
        handleProxyGenerate(fakeSender(), bad, 1, { generateProxy: async () => ((called = true), 'o'), now: () => 0 })
      ).rejects.toThrow()
      expect(called).toBe(false)
    }
  })

  it('rejects a non-string path', async () => {
    const s = fakeSender()
    await expect(handleProxyGenerate(s, 42 as unknown as string, 1, { generateProxy: async () => 'o', now: () => 0 })).rejects.toThrow()
  })
})

describe('handleProxyUsage', () => {
  it('sums size and count of existing proxies for the given videos only', () => {
    const sizes: Record<string, number> = { 'p/a.mp4': 100, 'p/c.mp4': 50 }
    const res = handleProxyUsage(['a', 'b', 'c'], {
      proxyPath: (v) => `p/${v}.mp4`,
      statSize: (p) => (p in sizes ? sizes[p] : null)
    })
    expect(res).toEqual({ count: 2, bytes: 150 })
  })

  it('ignores non-string entries and non-array input', () => {
    const deps = { proxyPath: (v: string) => `p/${v}`, statSize: () => 10 }
    expect(handleProxyUsage('x', deps)).toEqual({ count: 0, bytes: 0 })
    expect(handleProxyUsage(['a', 3, null], deps)).toEqual({ count: 1, bytes: 10 })
  })
})
