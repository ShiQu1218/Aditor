import { expect, test } from 'vitest'
import { obsoleteSegments, LOBBY_BUFFER_SEC } from './prune'
import { LiveSession } from './live-session'
import { MATCH_PRE_PAD_SEC, MATCH_POST_PAD_SEC } from './finalize'
import type { LiveMatch, LiveSegment } from '../../shared/recording'
const oldSelection = (segments: LiveSegment[], matches: LiveMatch[], pending: number | null, latest: number) =>
  segments.filter(s => s.pts + s.dur <= latest - LOBBY_BUFFER_SEC &&
    !(pending !== null && s.pts + s.dur > pending - MATCH_PRE_PAD_SEC) &&
    !matches.some(m => s.pts + s.dur > m.start - MATCH_PRE_PAD_SEC && (m.end === null || s.pts < m.end + MATCH_POST_PAD_SEC)))
let seed = 81
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
const session = () => new LiveSession({ sessionId: 'perf', dir: process.cwd(), profileDir: '', recordEvent: () => {}, notice: () => {} })
test('indexed cleanup preserves boundaries, overlaps, pending starts and delayed analysis', () => {
  for (let run = 0; run < 100; run++) {
    const segments = Array.from({ length: 100 }, (_, i) => ({ seq: i + 1, pts: i * 2, dur: 2 }))
    const matches = Array.from({ length: 20 }, () => { const start = Math.floor(random() * 180); return { start, end: random() > 0.9 ? null : start + Math.floor(random() * 15) } })
    const pending = run % 3 ? null : Math.floor(random() * 200)
    const latest = Math.floor(random() * 200)
    expect(obsoleteSegments(segments, matches, pending, latest)).toEqual(oldSelection(segments, matches, pending, latest))
  }
})
test('segment index preserves deduplication and public snapshots', async () => {
  const live = session()
  const segment = { seq: 1, pts: 0, dur: 2 }
  live.addSegment(segment)
  live.addSegment({ ...segment, pts: 99 })
  const first = await live.state()
  live.addSegment({ seq: 2, pts: 2, dur: 2 })
  expect(first.segments).toEqual([segment])
  expect((await live.state()).segments).toHaveLength(2)
  expect(live.hasSegment(1)).toBe(true)
  expect(live.hasSegment(3)).toBe(false)
})
test.skipIf(process.env.ADITOR_PERF !== '1')('compare live metadata costs', () => {
  const measure = (fn: () => unknown) => {
    fn()
    const samples = Array.from({ length: 5 }, () => { const t = performance.now(); fn(); return performance.now() - t })
    return samples.sort((a, b) => a - b)[2].toFixed(3)
  }
  for (const n of [1000, 2000, 4000, 8000]) {
    const segments = Array.from({ length: n }, (_, i) => ({ seq: i + 1, pts: i * 2, dur: 2 }))
    const matches = Array.from({ length: n / 10 }, (_, i) => ({ start: i * 20, end: i * 20 + 5 }))
    const oldAdd = () => { let list: LiveSegment[] = []; for (const s of segments) if (!list.some(v => v.seq === s.seq)) list = [...list, s]; return list }
    const newAdd = () => { const live = session(); for (const s of segments) live.addSegment(s); return live }
    expect(obsoleteSegments(segments, matches, null, n * 2)).toEqual(oldSelection(segments, matches, null, n * 2))
    console.log(`segments ${n}: old=${measure(oldAdd)}ms new=${measure(newAdd)}ms`)
    console.log(`prune ${n}: old=${measure(() => oldSelection(segments, matches, null, n * 2))}ms new=${measure(() => obsoleteSegments(segments, matches, null, n * 2))}ms`)
  }
})
