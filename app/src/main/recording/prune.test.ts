import { afterEach, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { pruneSegments } from './prune'
import { sessionDir, tempRoot } from './test-support'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
it('keeps only the most recent 15 seconds in a long lobby while leaving the index and initialization file unchanged', async () => {
  const root = tempRoot(); roots.push(root)
  const dir = sessionDir(root)
  const segments = Array.from({ length: 200 }, (_, i) => ({ seq: i + 1, pts: i * 2, dur: 2 }))
  for (const s of segments) fs.writeFileSync(path.join(dir, `seg_${String(s.seq).padStart(6, '0')}.m4s`), '片段')
  fs.writeFileSync(path.join(dir, 'init.mp4'), '初始化')
  fs.writeFileSync(path.join(dir, 'index.jsonl'), '索引')
  const removed = await pruneSegments(dir, segments, [], null)
  expect(removed).toHaveLength(191)
  expect(fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8')).toBe('索引')
  expect(fs.readFileSync(path.join(dir, 'init.mp4'), 'utf8')).toBe('初始化')
  expect(fs.existsSync(path.join(dir, 'pruned.json'))).toBe(true)
})
it.each([
  { matches: [], pending: 20, first: 8 },
  { matches: [{ start: 20, end: null }], pending: null, first: 8 },
  { matches: [{ start: 20, end: 40 }], pending: null, first: 8 },
  { matches: [{ start: 20, end: 40 }, { start: 45, end: null }], pending: 45, first: 8 },
  { matches: [], pending: null, first: 42 }
])('protects countdowns, matches, delayed confirmation, and immediate next-match queues: %j', async ({ matches, pending, first }) => {
  const root = tempRoot(); roots.push(root); const dir = sessionDir(root)
  const segments = Array.from({ length: 50 }, (_, i) => ({ seq: i + 1, pts: i * 2, dur: 2 }))
  for (const s of segments) fs.writeFileSync(path.join(dir, `seg_${String(s.seq).padStart(6, '0')}.m4s`), '片段')
  const removed = await pruneSegments(dir, segments, matches, pending)
  expect(removed.slice(0, first - 1)).toEqual(segments.slice(0, first - 1).map(s => s.seq))
  expect(removed).not.toContain(first)
  if (matches[0]?.end === 40) expect(removed).not.toContain(23)
})
it('cleans only processed segments when the engine is behind and preserves unprocessed countdown segments', async () => {
  const root = tempRoot(); roots.push(root); const dir = sessionDir(root)
  const segments = Array.from({ length: 200 }, (_, i) => ({ seq: i + 1, pts: i * 2, dur: 2 }))
  for (const s of segments) fs.writeFileSync(path.join(dir, `seg_${String(s.seq).padStart(6, '0')}.m4s`), '片段')
  const removed = await pruneSegments(dir, segments, [], null, 100)
  expect(removed).toEqual(segments.slice(0, 42).map(s => s.seq))
})
