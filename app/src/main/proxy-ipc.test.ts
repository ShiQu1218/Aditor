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
  it('只接受有限正數', () => {
    expect(parseProxyDuration(120)).toBe(120)
    for (const bad of [0, -1, NaN, Infinity, '12', undefined, null]) {
      expect(parseProxyDuration(bad)).toBeUndefined()
    }
  })
})

describe('handleProxyGenerate', () => {
  it('轉送進度並節流（>=250ms），完成時送出 1', async () => {
    const s = fakeSender()
    let now = 1000
    const gen = vi.fn(async (_p: string, onProgress?: (r: number) => void, _d?: number) => {
      onProgress?.(0.1) // 首次送出
      now += 100
      onProgress?.(0.2) // 節流掉
      now += 200
      onProgress?.(0.3) // 距上次 300ms → 送出
      now += 10
      onProgress?.(1) // 完成一律送出
      return 'out.mp4'
    })
    const r = await handleProxyGenerate(s, 'a.mp4', 60, { generateProxy: gen, now: () => now })
    expect(r).toBe('out.mp4')
    expect(gen.mock.calls[0][2]).toBe(60)
    expect(s.sent.map((m) => m.data.ratio)).toEqual([0.1, 0.3, 1])
    expect(s.sent.every((m) => m.channel === 'proxy:progress' && m.data.videoPath === 'a.mp4')).toBe(true)
  })

  it('視窗已銷毀就不送', async () => {
    const s = fakeSender(true)
    const gen = async (_p: string, on?: (r: number) => void) => {
      on?.(0.5)
      return 'o'
    }
    await handleProxyGenerate(s, 'a.mp4', 60, { generateProxy: gen, now: () => 0 })
    expect(s.sent).toEqual([])
  })

  it('send 丟例外（視窗中途銷毀）不影響結果', async () => {
    const s = fakeSender()
    s.send = () => {
      throw new Error('Object has been destroyed')
    }
    const gen = async (_p: string, on?: (r: number) => void) => {
      on?.(0.5)
      return 'o'
    }
    await expect(handleProxyGenerate(s, 'a.mp4', 60, { generateProxy: gen, now: () => 0 })).resolves.toBe('o')
  })

  it('duration 無效 → 以 undefined 傳給 generateProxy（無百分比）', async () => {
    const s = fakeSender()
    const gen = vi.fn(async (_p: string, _o?: (r: number) => void, _d?: number) => 'o')
    await handleProxyGenerate(s, 'a.mp4', NaN, { generateProxy: gen, now: () => 0 })
    expect(gen.mock.calls[0][2]).toBeUndefined()
  })

  it('錯誤向上拋出，且失敗後不再送進度', async () => {
    const s = fakeSender()
    let late: ((r: number) => void) | undefined
    const gen = async (_p: string, on?: (r: number) => void) => {
      late = on
      throw new Error('ffmpeg failed')
    }
    await expect(handleProxyGenerate(s, 'a.mp4', 60, { generateProxy: gen, now: () => 0 })).rejects.toThrow('ffmpeg failed')
    late?.(0.9)
    expect(s.sent).toEqual([])
  })

  it('路徑非字串 → 拒絕', async () => {
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
