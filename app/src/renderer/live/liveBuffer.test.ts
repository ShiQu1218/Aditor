import { describe, expect, test, vi } from 'vitest'
import { AHEAD_SEC, LiveBuffer, RETAIN_SEC, covers, type SourceBufferLike } from './liveBuffer'

/** Fake SourceBuffer: append/remove set updating=true; `finish()` simulates updateend; buffered reflects appended time ranges. */
class FakeSourceBuffer implements SourceBufferLike {
  mode = 'sequence'
  updating = false
  ranges: [number, number][] = []
  ops: string[] = []
  quota = false
  private listener: (() => void) | null = null
  pending: [number, number] | null = null
  get buffered() {
    const r = [...this.ranges].sort((a, b) => a[0] - b[0])
    return { length: r.length, start: (i: number) => r[i][0], end: (i: number) => r[i][1] }
  }
  appendBuffer(data: Uint8Array): void {
    if (this.updating) throw new Error('InvalidStateError')
    const text = new TextDecoder().decode(data)
    if (this.quota && text !== 'init') { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e }
    this.ops.push(`append ${text}`)
    const m = /^seg (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)$/.exec(text)
    this.pending = m ? [Number(m[1]), Number(m[1]) + Number(m[2])] : null
    this.updating = true
  }
  remove(start: number, end: number): void {
    this.ops.push(`remove ${start}-${end}`)
    this.ranges = this.ranges.flatMap(([a, b]) => (b <= start || a >= end ? [[a, b]] : [
      ...(a < start ? [[a, start] as [number, number]] : []), ...(b > end ? [[end, b] as [number, number]] : [])]))
    this.pending = null
    this.updating = true
  }
  addEventListener(_type: 'updateend', listener: () => void): void { this.listener = listener }
  removeEventListener(): void { this.listener = null }
  finish(): void {
    if (this.pending) this.ranges.push(this.pending)
    this.pending = null
    this.updating = false
    this.listener?.()
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))
function rig(time = 0, segs = 10) {
  const sb = new FakeSourceBuffer()
  const clock = { t: time }
  const segments = Array.from({ length: segs }, (_, i) => ({ seq: i + 1, pts: i * 2, dur: 2 }))
  const fetchSegment = vi.fn(async (seq: number) => new TextEncoder().encode(`seg ${segments[seq - 1].pts} 2`))
  const setDuration = vi.fn()
  const onError = vi.fn()
  const buffer = new LiveBuffer({ sourceBuffer: sb, fetchInit: async () => new TextEncoder().encode('init'),
    fetchSegment, currentTime: () => clock.t, setDuration, onError })
  return { sb, clock, segments, fetchSegment, buffer, setDuration, onError }
}
async function drain(sb: FakeSourceBuffer, rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await tick()
    if (sb.updating) sb.finish()
  }
}

describe('LiveBuffer segment queue', () => {
  test('does not reload a segment whose retained tail is still buffered', async () => {
    const sb = new FakeSourceBuffer()
    const fetchSegment = vi.fn(async () => new TextEncoder().encode('seg 100 2'))
    const buffer = new LiveBuffer({ sourceBuffer: sb, fetchInit: async () => new TextEncoder().encode('init'),
      fetchSegment, currentTime: () => 101.8 })
    buffer.setSegments([{ seq: 1, pts: 100, dur: 2 }, { seq: 2, pts: 1900, dur: 1.5 }])
    await drain(sb, 12)
    buffer.revalidate()
    await drain(sb, 12)
    expect(fetchSegment).toHaveBeenCalledTimes(1)
    expect(sb.ops.filter((op) => op.startsWith('remove'))).toEqual(['remove 100-101.5'])
    expect(sb.buffered.start(0)).toBe(101.5)
    expect(sb.buffered.end(0)).toBe(102)
    buffer.dispose()
  })
  test('evicts future buffers after a backward seek and retries the requested segment', async () => {
    const r = rig(110, 60)
    r.buffer.setSegments(r.segments)
    await drain(r.sb)
    r.sb.ranges = [[100, 120]]
    r.sb.quota = true
    r.clock.t = 20
    r.buffer.revalidate()
    await tick()
    expect(r.sb.ops).toContain('remove 28-120')
    r.sb.quota = false
    await drain(r.sb)
    expect(r.sb.ranges.some(([start, end]) => start <= 20 && end > 20)).toBe(true)
    expect(r.onError).not.toHaveBeenCalled()
    r.buffer.dispose()
  })

  test('reloads a partially evicted segment when seeking into its missing tail', async () => {
    const r = rig(10, 10)
    r.buffer.setSegments(r.segments)
    await drain(r.sb)
    const before = r.fetchSegment.mock.calls.filter(([seq]) => seq === 6).length
    r.sb.ranges = [[8, 11.9]]
    r.clock.t = 11.95
    r.buffer.revalidate()
    await drain(r.sb)
    expect(r.fetchSegment.mock.calls.filter(([seq]) => seq === 6)).toHaveLength(before + 1)
    expect(covers(r.sb.buffered, 11.95)).toBe(true)
    r.buffer.dispose()
  })

  test('reports quota failure when no buffered range can be evicted', async () => {
    const r = rig(0, 3)
    r.sb.quota = true
    r.buffer.setSegments(r.segments)
    await drain(r.sb)
    expect(r.onError).toHaveBeenCalledWith(expect.objectContaining({ name: 'QuotaExceededError' }))
    r.buffer.dispose()
  })
  test('Appends init first, then nearby segments in order; performs one operation at a time', async () => {
    const r = rig(0)
    expect(r.sb.mode).toBe('segments')
    r.buffer.setSegments(r.segments)
    await tick()
    expect(r.sb.ops).toEqual(['append init'])
    r.buffer.pump()
    await tick()
    expect(r.sb.ops).toEqual(['append init'])
    await drain(r.sb)
    const appended = r.sb.ops.filter((op) => op.startsWith('append seg')).map((op) => Number(op.split(' ')[2]))
    expect(appended).toEqual(appended.slice().sort((a, b) => a - b))
    expect(Math.max(...appended)).toBeLessThan(AHEAD_SEC)
    expect(r.setDuration).toHaveBeenLastCalledWith(20)
  })

  test('Appends new segments as they arrive and fetches segments at a sought time', async () => {
    const r = rig(15, 10)
    r.buffer.setSegments(r.segments.slice(0, 8))
    await drain(r.sb)
    expect(r.fetchSegment).toHaveBeenCalledWith(8)
    expect(r.fetchSegment).not.toHaveBeenCalledWith(1)
    r.buffer.addSegment(r.segments[8])
    await drain(r.sb)
    expect(r.fetchSegment).toHaveBeenCalledWith(9)
    expect(r.buffer.liveEnd()).toBe(18)
    r.clock.t = 1
    r.buffer.revalidate()
    await drain(r.sb)
    expect(r.fetchSegment).toHaveBeenCalledWith(1)
  })

  test('Releases buffered content older than 30 minutes with remove() and does not fetch it again', async () => {
    const segs = RETAIN_SEC / 2 + 20
    const r = rig(0, segs)
    r.buffer.setSegments(r.segments.slice(0, 5))
    await drain(r.sb)
    expect(r.sb.buffered.start(0)).toBe(0)
    r.clock.t = (segs - 3) * 2
    r.buffer.setSegments(r.segments)
    await drain(r.sb)
    const retain = r.buffer.retainStart()
    expect(retain).toBe(segs * 2 - RETAIN_SEC)
    expect(r.sb.ops).toContain(`remove 0-${retain}`)
    expect(r.sb.buffered.start(0)).toBeGreaterThanOrEqual(retain)
    const early = r.fetchSegment.mock.calls.filter(([seq]) => seq <= 5).length
    r.clock.t = 0
    r.buffer.revalidate()
    await drain(r.sb)
    expect(r.fetchSegment.mock.calls.filter(([seq]) => seq <= 5)).toHaveLength(early)
  })

  test('On quota exhaustion, removes data before the playhead; failed fetches retry up to a limit and report the failure', async () => {
    const r = rig(10, 10)
    r.buffer.setSegments(r.segments)
    await drain(r.sb)
    r.sb.ranges = [[0, 20]]
    r.clock.t = 12
    r.sb.quota = true
    r.buffer.addSegment({ seq: 11, pts: 20, dur: 2 })
    r.clock.t = 19
    r.buffer.revalidate()
    await drain(r.sb)
    expect(r.sb.ops.some((op) => op.startsWith('remove 0-17'))).toBe(true)
    r.sb.quota = false

    const failing = rig(0, 3)
    failing.fetchSegment.mockRejectedValue(new Error('gone'))
    failing.buffer.setSegments(failing.segments)
    await drain(failing.sb)
    for (let i = 0; i < 5; i++) { failing.buffer.pump(); await drain(failing.sb, 3) }
    expect(failing.fetchSegment.mock.calls.filter(([seq]) => seq === 1)).toHaveLength(3)
    expect(failing.onError).toHaveBeenCalled()
  })

  test('Does not operate on SourceBuffer after dispose', async () => {
    const r = rig(0)
    r.buffer.setSegments(r.segments)
    r.buffer.dispose()
    await drain(r.sb)
    expect(r.sb.ops).toEqual([])
    expect(covers({ length: 1, start: () => 0, end: () => 2 }, 1)).toBe(true)
    expect(covers({ length: 1, start: () => 0, end: () => 2 }, 2)).toBe(false)
  })
})

test('List can start at a later sequence number and removes already-pruned segments', async () => {
  const r = rig(16)
  r.buffer.setSegments(r.segments.slice(8))
  await drain(r.sb)
  expect(r.onError).not.toHaveBeenCalled()
  expect(r.fetchSegment.mock.calls.every(([seq]) => seq >= 9)).toBe(true)
  r.buffer.setSegments(r.segments.slice(9))
  r.clock.t = 0
  r.buffer.revalidate()
  await drain(r.sb)
  expect(r.fetchSegment.mock.calls.every(([seq]) => seq >= 9)).toBe(true)
  expect(r.onError).not.toHaveBeenCalled()
  r.buffer.dispose()
})
