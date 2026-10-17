import { describe, expect, test } from 'vitest'
import type { CacheDoc, Clip, EngineEvent } from '../../shared/types'
import { createProject, ProjectItem } from '../editor/project'
import { viewerReducer } from '../viewer/state'
import {
  acceptToProject,
  planAddAll,
  applyAutoClip,
  clipEventGlyphs,
  clipTitle,
  mergeSuggestions,
  nextSuggestion,
  planAccept,
  planSuggestions,
  removeProjectItems,
  shouldAutoPlace,
  toSuggestions,
  withProjectStatus
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
  test('applying popover replaces only suggested ai clips, keeps accepted, skipped and manual', () => {
    const accepted = clip('a1', 100, { status: 'accepted' })
    const manual = clip('m1', 200, { origin: 'manual', status: 'accepted' })
    const suggested = clip('s1', 300)
    const skipped = clip('k1', 400, { status: 'skipped' })
    const old = [accepted, manual, suggested, skipped]

    const next = applyAutoClip(old, [clip('n1', 20, { status: undefined }), clip('n2', 300, { status: undefined })])

    // 只有 suggested 被取代；已略過保留原狀
    expect(next.map((c) => c.id)).toEqual(['n1', 'a1', 'm1', 'n2', 'k1'])
    expect(next.find((c) => c.id === 's1')).toBeUndefined()
    expect(next.find((c) => c.id === 'n1')?.status).toBe('suggested')
    expect(next.find((c) => c.id === 'n2')?.status).toBe('suggested')
    expect(next.find((c) => c.id === 'k1')).toEqual(skipped)
    expect(next.find((c) => c.id === 'a1')).toEqual(accepted)
    expect(next.find((c) => c.id === 'm1')).toEqual(manual)
    // 不改動輸入陣列
    expect(old).toHaveLength(4)

    // 與保留片段起點 <1s 的新建議不重複
    expect(applyAutoClip([accepted], [clip('near', 100.4)]).map((c) => c.id)).toEqual(['a1'])
  })

  test('a new ai clip within 1s of a skipped clip is not re-suggested', () => {
    const skipped = clip('k1', 400, { status: 'skipped' })
    const next = applyAutoClip([skipped], [clip('again', 400.5), clip('far', 600)])
    expect(next.map((c) => c.id)).toEqual(['k1', 'far'])
    expect(next[0].status).toBe('skipped')
  })
})

describe('planAccept (single-card add + Toast undo)', () => {
  const empty = { version: 1 as const, name: 'p', items: [] }

  test('adding returns project change, accepted status and an undo that removes the item and restores the clip', () => {
    const c = clip('c1', 40, { end: 80 })
    const plan = planAccept(c, 'v.mp4', empty)
    expect(plan.notice).toBe('added')
    expect(plan.project.items).toHaveLength(1)
    expect(plan.clipStatus).toBe('accepted')
    expect(plan.undo?.clipStatus).toBe('suggested')
    // 在最新專案上套用復原
    const later = { ...plan.project, name: 'renamed' }
    const undone = plan.undo!.project(later)
    expect(undone.items).toHaveLength(0)
    expect(undone.name).toBe('renamed')
  })

  test('duplicate: nothing added -> info notice, no undo, project untouched, clip still marked accepted', () => {
    const c = clip('c1', 40, { end: 80 })
    const first = planAccept(c, 'v.mp4', empty)
    const again = planAccept(c, 'v.mp4', first.project)
    expect(again.notice).toBe('duplicate')
    expect(again.undo).toBeNull()
    expect(again.project).toBe(first.project)
    expect(again.clipStatus).toBe('accepted')
  })
})

describe('planSuggestions + mergeSuggestions (real data flow)', () => {
  const settings = { autoSuggestOnOpen: true, autoclip: { n: 3, gap: 20, before: 8, after: 4, max_len: 90 } }
  // 引擎 analyze 回傳的文件只有手動片段（engine/apexhl/analyze.py）
  const engineDoc = doc({ events: [ev('e1', 100), ev('e2', 105), ev('e3', 110)], clips: [clip('m1', 500, { origin: 'manual', status: 'accepted' })] })

  test('load path: auto-place only when enabled and no ai clips; never marks stale', () => {
    expect(planSuggestions({ doc: engineDoc, clips: engineDoc.clips, settings, reanalyzed: false })).toEqual({
      kind: 'place',
      params: settings.autoclip
    })
    expect(
      planSuggestions({ doc: engineDoc, clips: engineDoc.clips, settings: { ...settings, autoSuggestOnOpen: false }, reanalyzed: false })
    ).toEqual({ kind: 'none' })
    const withAi = [clip('a1', 10, { status: 'accepted' })]
    expect(planSuggestions({ doc: doc({ events: engineDoc.events, clips: withAi }), clips: withAi, settings, reanalyzed: false })).toEqual({ kind: 'none' })
    // 沒有事件＝不呼叫
    expect(planSuggestions({ doc: doc(), clips: [], settings, reanalyzed: false })).toEqual({ kind: 'none' })
  })

  test('re-analysis always re-runs autoclip with default params, even if autoSuggestOnOpen is off', () => {
    const plan = planSuggestions({
      doc: engineDoc,
      clips: engineDoc.clips,
      settings: { ...settings, autoSuggestOnOpen: false },
      reanalyzed: true
    })
    expect(plan).toEqual({ kind: 'merge', params: settings.autoclip })
    // 分析未完成不執行
    expect(
      planSuggestions({ doc: doc({ events: engineDoc.events, analysis: { ...doc().analysis, status: 'partial' } }), clips: [], settings, reanalyzed: true })
    ).toEqual({ kind: 'none' })
  })

  test('REAL load flow: fresh studio (empty state) + main-rewritten doc with suggestionsPending -> stale accepted kept, new suggested placed, flag cleared; second open does nothing', () => {
    const fresh0 = { doc: doc(), filter: new Set<never>(), clips: [] as Clip[], dirty: false }
    // main 在重新分析後改寫的文件：手動片段＋已加入（stale）的 AI 片段，旗標 suggestionsPending
    const onDisk = doc({
      events: [ev('e1', 100), ev('e2', 105), ev('e3', 110)],
      clips: [
        clip('a1', 100, { status: 'accepted', stale: true }),
        clip('m1', 500, { origin: 'manual', status: 'accepted' })
      ],
      app: { suggestionsPending: true }
    })

    // 1) 載入：工作室全新掛載，狀態沒有任何片段（重新分析只存在影片庫）
    let state = viewerReducer(fresh0, { type: 'analysisResult', doc: onDisk })
    expect(state.clips.map((c) => c.id)).toEqual(['a1', 'm1'])
    expect(state.doc.app?.suggestionsPending).toBe(true)
    expect(state.dirty).toBe(false)

    // 2) 規劃：由文件旗標決定（不是由「狀態裡有沒有 AI 片段」）；autoSuggestOnOpen 關閉也要重算
    const plan = planSuggestions({ doc: state.doc, clips: state.clips, settings: { ...settings, autoSuggestOnOpen: false } })
    expect(plan).toEqual({ kind: 'merge', params: settings.autoclip })

    // 3) autoclip 新結果：一段與保留片段重疊、一段全新 -> 合併後套用並清除旗標
    const freshAi = [clip('f1', 100.3, { status: undefined }), clip('f2', 700, { status: undefined })]
    const merged = mergeSuggestions('merge', state.clips, freshAi)
    state = viewerReducer(state, { type: 'applySuggestions', clips: merged })
    expect(state.clips.map((c) => [c.id, c.status, c.stale ?? false])).toEqual([
      ['a1', 'accepted', true],
      ['m1', 'accepted', false],
      ['f2', 'suggested', false]
    ])
    expect(state.doc.clips).toEqual(state.clips)
    expect(state.doc.app?.suggestionsPending).toBe(false)
    expect(state.dirty).toBe(true) // 之後由 1 秒去抖存檔

    // 4) 第二次開啟（讀回剛存的文件，旗標已清除）：不再規劃；使用者之後的略過不會被覆蓋
    const skipped = viewerReducer(state, { type: 'skipClip', id: 'f2' })
    const reopened = viewerReducer(fresh0, { type: 'analysisResult', doc: skipped.doc })
    expect(planSuggestions({ doc: reopened.doc, clips: reopened.clips, settings })).toEqual({ kind: 'none' })
    expect(reopened.clips.find((c) => c.id === 'f2')?.status).toBe('skipped')
  })

  test('flag cleared without touching clips when there is nothing to suggest (applySuggestions keeps docs without app untouched)', () => {
    const base = { doc: doc({ clips: [clip('m1', 10, { origin: 'manual', status: 'accepted' })] }), filter: new Set<never>(), clips: [] as Clip[], dirty: false }
    const s = viewerReducer(base, { type: 'applySuggestions', clips: base.doc.clips })
    expect(s.doc.app).toBeUndefined()
    const pending = viewerReducer(
      { ...base, doc: { ...base.doc, app: { suggestionsPending: true } } },
      { type: 'applySuggestions', clips: base.doc.clips }
    )
    expect(pending.doc.app).toEqual({ suggestionsPending: false })
    // 使用者在合併前自己套用浮層（applyClips）也視為已決定：旗標一併清除
    const popover = viewerReducer(
      { ...base, doc: { ...base.doc, app: { suggestionsPending: true } } },
      { type: 'applyClips', clips: base.doc.clips }
    )
    expect(popover.doc.app).toEqual({ suggestionsPending: false })
  })

  test('place mode keeps manual clips and adds suggestions; fresh ai clips replace nothing else', () => {
    const merged = mergeSuggestions('place', engineDoc.clips, [clip('f1', 20, { status: undefined })])
    expect(merged.map((c) => [c.id, c.status])).toEqual([
      ['f1', 'suggested'],
      ['m1', 'accepted']
    ])
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

describe('planAddAll (Ctrl+E twice must not duplicate)', () => {
  const clips: Clip[] = [
    { id: 'a', start: 10, end: 20, origin: 'ai', status: 'suggested', event_ids: [] },
    { id: 'b', start: 30, end: 40, origin: 'ai', status: 'suggested', event_ids: [] }
  ]
  const empty = { version: 1 as const, name: 'p', items: [] }
  test('adds every suggestion once; a second run on the result adds nothing', () => {
    const first = planAddAll(clips, 'C:/v/a.mp4', empty)
    expect(first.addedIds).toHaveLength(2)
    expect(first.project.items).toHaveLength(2)
    const second = planAddAll(clips, 'C:/v/a.mp4', first.project)
    expect(second.addedIds).toHaveLength(0)
    expect(second.project).toBe(first.project)
    expect(second.project.items).toHaveLength(2)
  })
  test('no suggestions -> nothing', () => {
    expect(planAddAll([], 'C:/v/a.mp4', empty).addedIds).toHaveLength(0)
  })
})

describe('withProjectStatus（已加入＝專案內實際有對應片段）', () => {
  const src = 'C:/v/a.mp4'
  const item = (id: string, start: number, end: number, source = src): ProjectItem => ({ id, source, start, end })

  test('accepted clip whose project item was removed shows as suggestion again', () => {
    const clips = [clip('c1', 10, { status: 'accepted' }), clip('c2', 50, { status: 'accepted' })]
    const shown = withProjectStatus(clips, src, createProject('P', [item('i2', 50, 60)]))
    expect(shown.map((c) => c.status)).toEqual(['suggested', 'accepted'])
  })

  test('trimmed project item still counts as added (overlap, not exact match)', () => {
    const shown = withProjectStatus([clip('c1', 10, { status: 'accepted' })], src, createProject('P', [item('i1', 12, 18)]))
    expect(shown[0].status).toBe('accepted')
  })

  test('item from another source or touching only at the edge does not count', () => {
    const p = createProject('P', [item('i1', 10, 20, 'C:/v/b.mp4'), item('i2', 20, 30)])
    expect(withProjectStatus([clip('c1', 10, { status: 'accepted' })], src, p)[0].status).toBe('suggested')
  })

  test('legacy clips without status are treated as accepted; suggested/skipped untouched', () => {
    const clips = [clip('c1', 10, { status: undefined }), clip('c2', 30), clip('c3', 50, { status: 'skipped' })]
    const shown = withProjectStatus(clips, src, createProject('P'))
    expect(shown.map((c) => c.status)).toEqual(['suggested', 'suggested', 'skipped'])
  })

  test('source paths compare case- and slash-insensitively; unchanged clips keep identity', () => {
    const clips = [clip('c1', 10, { status: 'accepted' })]
    const shown = withProjectStatus(clips, src, createProject('P', [item('i1', 10, 20, 'c:\\v\\A.mp4')]))
    expect(shown[0]).toBe(clips[0])
  })
})
