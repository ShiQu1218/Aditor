import { expect, test } from 'vitest'
import type { Clip } from '../../shared/types'
import { retainedStartLookup } from '../../shared/clips'
import { viewerReducer, type ViewerState } from '../viewer/state'
import { createProject, type Project } from '../editor/project'
import { acceptToProject, linkedItem, mirrorLinkedClips, planAddAll, withProjectStatus } from './highlights'
const clip = (i: number, start = i * 3): Clip => ({ id: `c${i}`, start, end: start + 1, origin: 'ai', status: 'accepted', event_ids: [] })
function oldAdd(clips: Clip[], project: Project): Project {
  let next = project
  for (const c of clips) {
    const res = acceptToProject(c, 'a', next)
    if (res.added.length) next = { ...next, items: [...next.items, ...res.added] }
  }
  return next
}
function oldStatus(clips: Clip[], project: Project): Clip[] {
  return clips.map((c) => (c.status ?? 'accepted') !== 'accepted' || project.items.some((it) => it.source === 'a' && it.start < c.end && it.end > c.start) ? c : { ...c, status: 'suggested' })
}
function oldMirror(clips: Clip[], project: Project): Clip[] {
  return clips.flatMap((c) => {
    const item = linkedItem(c, 'a', project)
    return !item || (item.start === c.start && item.end === c.end) ? [] : [{ ...c, start: item.start, end: item.end }]
  })
}
const withoutIds = (p: Project) => p.items.map(({ id: _id, ...rest }) => rest)
let seed = 137
function random(): number { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
test('indexes preserve sequential behavior, epsilon boundaries and duplicate links', () => {
  for (let run = 0; run < 60; run++) {
    const clips = Array.from({ length: 50 }, (_, i) => clip(i, Math.floor(random() * 30) + [0, 0.000999999, 0.001, 0.001000001][i % 4]))
    const project = createProject('test', clips.slice(0, 30).map((c, i) => ({ id: `i${i}`, source: i % 3 ? 'a' : 'b', start: c.start, end: c.end, clipId: `c${i % 20}` })))
    expect(withoutIds(planAddAll(clips, 'a', project).project)).toEqual(withoutIds(oldAdd(clips, project)))
    expect(withProjectStatus(clips, 'a', project)).toEqual(oldStatus(clips, project))
    expect(mirrorLinkedClips(project, 'a', clips)).toEqual(oldMirror(clips, project))
    const near = retainedStartLookup(clips)
    for (const start of [...clips.map((c) => c.start + 1), ...clips.map((c) => c.start - 0.999999), NaN, Infinity]) expect(near(start)).toBe(clips.some((c) => Math.abs(c.start - start) < 1))
  }
})
test('batch reducer actions equal sequential updates and preserve no-ops', () => {
  const clips = [clip(1), clip(2), { ...clip(3), origin: 'manual' as const }]
  const state = { clips, doc: { clips }, dirty: false, filter: new Set() } as ViewerState
  for (const status of ['accepted', 'suggested'] as const) {
    const ids = ['c1', 'c3', 'missing']
    const expected = ids.reduce((s, id) => viewerReducer(s, { type: status === 'accepted' ? 'acceptClip' : 'restoreClip', id }), state)
    const actual = viewerReducer(state, { type: 'setClipStatuses', ids, status })
    expect(actual).toEqual(expected)
    if (expected === state) expect(actual).toBe(state)
  }
  const updates = clips.map((c) => ({ ...c, end: c.end + 2 }))
  expect(viewerReducer(state, { type: 'updateClips', clips: updates })).toEqual(updates.reduce((s, c) => viewerReducer(s, { type: 'updateClip', clip: c }), state))
  expect(viewerReducer(state, { type: 'updateClips', clips: [] })).toBe(state)
})
// Run explicitly with ADITOR_PERF=1; do not assert wall-clock timing in CI.
test.skipIf(process.env.ADITOR_PERF !== '1')('compare old and indexed algorithms', () => {
  function measure(fn: () => unknown): number {
    fn()
    const times = Array.from({ length: 5 }, () => { const t = performance.now(); fn(); return performance.now() - t })
    return times.sort((a, b) => a - b)[2]
  }
  for (const n of [1000, 2000, 4000, 8000]) {
    const clips = Array.from({ length: n }, (_, i) => clip(i))
    const project = createProject('test', clips.map((c, i) => ({ id: `i${i}`, source: 'a', start: c.start + 1, end: c.end + 1, clipId: c.id })))
    const oldNear = () => clips.map((c) => project.items.some((it) => Math.abs(it.start - c.start) < 1))
    const newNear = () => { const near = retainedStartLookup(project.items as unknown as Clip[]); return clips.map((c) => near(c.start)) }
    expect(newNear()).toEqual(oldNear())
    const state = { clips, doc: { clips }, dirty: false, filter: new Set() } as ViewerState
    const ids = clips.map((c) => c.id)
    const oldBatch = () => ids.reduce((s, id) => viewerReducer(s, { type: 'restoreClip', id }), state)
    const newBatch = () => viewerReducer(state, { type: 'setClipStatuses', ids, status: 'suggested' })
    expect(newBatch()).toEqual(oldBatch())
    for (const [name, before, after] of [
      ['add', () => oldAdd(clips, project), () => planAddAll(clips, 'a', project)],
      ['status', () => oldStatus(clips, project), () => withProjectStatus(clips, 'a', project)],
      ['mirror', () => oldMirror(clips, project), () => mirrorLinkedClips(project, 'a', clips)],
      ['retained', oldNear, newNear],
      ['batch', oldBatch, newBatch]
    ] as const) console.log(`${name} n=${n} old=${measure(before).toFixed(3)}ms new=${measure(after).toFixed(3)}ms`)
  }
}, 120000)
