import { describe, expect, test } from 'vitest'
import type { CacheDoc, Clip, EngineEvent } from '../../shared/types'
import { createProject, ProjectItem } from '../editor/project'
import {
  acceptToProject,
  applyAutoClip,
  clipEventGlyphs,
  clipTitle,
  nextSuggestion,
  removeProjectItems,
  shouldAutoPlace,
  toSuggestions
} from './highlights'

function ev(id: string, t: number, over: Partial<EngineEvent> = {}): EngineEvent {
  return {
    id,
    t,
    type: 'knock',
    score: 1,
    damage_line: false,
    name_sig: null,
    counted: true,
    counted_reason: 'first',
    counted_override: null,
    source: 'auto',
    ...over
  }
}

function doc(over: Partial<CacheDoc> = {}): CacheDoc {
  return {
    version: 1,
    video: { path: 'v.mp4', size: 1, mtime: 1, duration: 600, width: 1920, height: 1080, codec: 'h264', start_time: 0 },
    profile: 'zh-TW',
    analysis: { status: 'done', progress_t: 0, engine_version: '0.1.0', templates_version: 'zh-TW@1', h_scale: 1 },
    events: [],
    spectating: [],
    clips: [],
    keyframes: [],
    cache_path: '',
    ...over
  }
}

function clip(id: string, start: number, over: Partial<Clip> = {}): Clip {
  return { id, start, end: start + 10, origin: 'ai', event_ids: [], status: 'suggested', ...over }
}

describe('shouldAutoPlace', () => {
  test('shouldAutoPlace only when enabled, analysis done and no existing ai clips', () => {
    expect(shouldAutoPlace(doc(), { autoSuggestOnOpen: true })).toBe(true)
    expect(shouldAutoPlace(doc(), { autoSuggestOnOpen: false })).toBe(false)
    expect(
      shouldAutoPlace(doc({ analysis: { ...doc().analysis, status: 'partial' } }), { autoSuggestOnOpen: true })
    ).toBe(false)
    // 已有任何 AI 片段（含已加入／已略過）＝不再自動放
    expect(shouldAutoPlace(doc({ clips: [clip('c1', 10, { status: 'accepted' })] }), { autoSuggestOnOpen: true })).toBe(false)
    expect(shouldAutoPlace(doc({ clips: [clip('c2', 10, { status: 'skipped' })] }), { autoSuggestOnOpen: true })).toBe(false)
    // 手動片段不算
    expect(shouldAutoPlace(doc({ clips: [clip('m1', 10, { origin: 'manual' })] }), { autoSuggestOnOpen: true })).toBe(true)
  })
})

describe('toSuggestions', () => {
  test('engine autoclip output becomes suggested ai clips', () => {
    const raw = [{ id: 'c1', start: 0, end: 10, origin: 'ai' as const, event_ids: ['e1'] }]
    const out = toSuggestions(raw)
    expect(out).toHaveLength(1)
    expect(out[0].status).toBe('suggested')
    expect(out[0].event_ids).toEqual(['e1'])
  })
})

describe('applyAutoClip', () => {
  test('applying popover replaces only suggested ai clips, keeps accepted and manual', () => {
    const accepted = clip('a1', 100, { status: 'accepted' })
    const manual = clip('m1', 200, { origin: 'manual', status: 'accepted' })
    const suggested = clip('s1', 300)
    const skipped = clip('k1', 400, { status: 'skipped' })
    const old = [accepted, manual, suggested, skipped]

    const next = applyAutoClip(old, [clip('n1', 20, { status: undefined }), clip('n2', 300, { status: undefined })])

    // suggested／skipped 被取代，新片段回到 suggested
    expect(next.map((c) => c.id)).toEqual(['n1', 'a1', 'm1', 'n2'])
    expect(next.find((c) => c.id === 'n1')?.status).toBe('suggested')
    expect(next.find((c) => c.id === 'n2')?.status).toBe('suggested')
    // 已加入與手動保持原狀（不被標 stale）
    expect(next.find((c) => c.id === 'a1')).toEqual(accepted)
    expect(next.find((c) => c.id === 'm1')).toEqual(manual)
    // 不改動輸入陣列
    expect(old).toHaveLength(4)

    // 與保留片段起點 <1s 的新建議不重複
    expect(applyAutoClip([accepted], [clip('near', 100.4)]).map((c) => c.id)).toEqual(['a1'])
  })
})

describe('acceptToProject', () => {
  test('acceptToProject appends items once (idempotent) and returns an undo that removes exactly them', () => {
    const c = clip('c1', 40, { end: 80 })
    const p0 = createProject('P')

    const r1 = acceptToProject(c, 'v.mp4', p0)
    expect(r1.added).toHaveLength(1)
    expect(r1.added[0]).toMatchObject({ source: 'v.mp4', start: 40, end: 80 })

    const p1 = { ...p0, items: [...p0.items, ...r1.added] }
    const r2 = acceptToProject(c, 'v.mp4', p1)
    expect(r2.added).toHaveLength(0)

    // undo 只移除本次加入的片段
    const other: ProjectItem = { id: 'x1', source: 'v.mp4', start: 500, end: 510 }
    const withOther = { ...p1, items: [...p1.items, other] }
    const undone = r1.undo(withOther)
    expect(undone.items.map((i) => i.id)).toEqual(['x1'])

    // 相同時間但不同來源視為不同片段
    const r3 = acceptToProject(c, 'other.mp4', p1)
    expect(r3.added).toHaveLength(1)
  })
})

describe('removeProjectItems', () => {
  test('filters exactly the given ids', () => {
    const p = createProject('P', [
      { id: 'a', source: 'v', start: 0, end: 1 },
      { id: 'b', source: 'v', start: 1, end: 2 }
    ])
    expect(removeProjectItems(p, ['a']).items.map((i) => i.id)).toEqual(['b'])
    expect(removeProjectItems(p, []).items).toHaveLength(2)
  })
})

describe('clipTitle', () => {
  test('clipTitle counts only counted events; manual clip titled 快速剪輯', () => {
    const events = [
      ev('e1', 1),
      ev('e2', 2, { counted: false, counted_reason: 'spectating' }),
      ev('e3', 3, { counted: false, counted_override: true }),
      ev('e4', 4, { counted: true })
    ]
    expect(clipTitle(clip('c1', 0, { event_ids: ['e1', 'e2', 'e3', 'e4'] }), events)).toBe('3 殺精華')
    // 已軟刪除的事件不計
    expect(clipTitle(clip('c2', 0, { event_ids: ['e1', 'e2'] }), [events[0], { ...events[1], deleted: true }])).toBe('1 殺精華')
    // 手動片段固定「快速剪輯」
    expect(clipTitle(clip('m1', 0, { origin: 'manual', event_ids: ['e1'] }), events)).toBe('快速剪輯')
    // 沒有計入事件
    expect(clipTitle(clip('c3', 0, { event_ids: ['e2'] }), events)).toBe('精華片段')
  })
})

describe('clipEventGlyphs', () => {
  test('clipEventGlyphs caps at 12 and marks uncounted', () => {
    const events = Array.from({ length: 20 }, (_, i) =>
      ev(`e${i}`, i, { type: i % 2 === 0 ? 'knock' : 'elim', counted: i % 3 !== 0 })
    )
    const row = clipEventGlyphs(clip('c1', 0, { event_ids: events.map((e) => e.id) }), events)
    expect(row.glyphs).toHaveLength(12)
    expect(row.overflow).toBe(8)
    expect(row.glyphs[0]).toEqual({ type: 'knock', counted: false })
    expect(row.glyphs[1]).toEqual({ type: 'elim', counted: true })

    const small = clipEventGlyphs(clip('c2', 0, { event_ids: ['e0'] }), events, 5)
    expect(small.glyphs).toHaveLength(1)
    expect(small.overflow).toBe(0)

    // 找不到的事件（來源已變）直接略過
    expect(clipEventGlyphs(clip('c3', 0, { event_ids: ['gone'] }), events).glyphs).toEqual([])
  })
})

describe('nextSuggestion', () => {
  test('nextSuggestion skips accepted/skipped and wraps', () => {
    const clips = [
      clip('a1', 0, { status: 'accepted' }),
      clip('s1', 10),
      clip('k1', 20, { status: 'skipped' }),
      clip('s2', 30)
    ]
    expect(nextSuggestion(clips, null, 1)).toBe('s1')
    expect(nextSuggestion(clips, 's1', 1)).toBe('s2')
    expect(nextSuggestion(clips, 's2', 1)).toBe('s1') // 環繞
    expect(nextSuggestion(clips, 's1', -1)).toBe('s2') // 往前環繞
    expect(nextSuggestion(clips, null, -1)).toBe('s2')
    expect(nextSuggestion([clip('a1', 0, { status: 'accepted' })], null, 1)).toBeNull()
    // status undefined（舊檔）視為已加入，不算建議
    const legacy = [{ ...clip('l1', 0) }] as Clip[]
    delete legacy[0].status
    expect(nextSuggestion(legacy, null, 1)).toBeNull()
  })
})
