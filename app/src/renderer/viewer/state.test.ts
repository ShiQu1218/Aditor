import { describe, it, expect } from 'vitest'
import { viewerReducer, ViewerState } from './state'
import { CacheDoc, Clip, EngineEvent, EventType } from '../../shared/types'

function makeTestDoc(): CacheDoc {
  return {
    version: 1,
    video: {
      path: 'video.mp4',
      size: 1000,
      mtime: 1234,
      duration: 100,
      width: 1920,
      height: 1080,
      codec: 'h264',
      start_time: 0
    },
    profile: 'zh-TW',
    analysis: {
      status: 'done',
      progress_t: 100,
      engine_version: '0.1.0',
      templates_version: 'zh-TW@1',
      h_scale: 1.0
    },
    events: [
      {
        id: 'e1',
        t: 10,
        type: 'knock',
        score: 0.9,
        damage_line: true,
        name_sig: null,
        counted: true,
        counted_reason: 'first',
        counted_override: null,
        source: 'auto'
      },
      {
        id: 'e2',
        t: 20,
        type: 'knock',
        score: 0.85,
        damage_line: true,
        name_sig: null,
        counted: true,
        counted_reason: 'first',
        counted_override: null,
        source: 'auto'
      }
    ],
    spectating: [],
    clips: [],
    keyframes: [0, 10, 20],
    cache_path: '/path/to/cache.json'
  }
}

describe('viewerReducer', () => {
  it('addManualEvent creates manual event with null sig', () => {
    const initialState: ViewerState = {
      doc: makeTestDoc(),
      filter: new Set<EventType>(['knock']),
      clips: [],
      dirty: false
    }

    const state = viewerReducer(initialState, {
      type: 'addManualEvent',
      t: 15.5,
      eventType: 'assist_knock'
    })

    expect(state.doc.events.length).toBe(3)
    const added = state.doc.events.find((e) => e.t === 15.5)
    expect(added).toBeDefined()
    expect(added?.source).toBe('manual')
    expect(added?.name_sig).toBeNull()
    expect(added?.id.startsWith('m')).toBe(true)
    expect(state.dirty).toBe(true)
  })

  it('setAiClips replaces only ai clips', () => {
    const initialState: ViewerState = {
      doc: makeTestDoc(),
      filter: new Set(),
      clips: [
        { id: 'c_manual', start: 5, end: 15, origin: 'manual', event_ids: [] },
        { id: 'c_old_ai', start: 30, end: 40, origin: 'ai', event_ids: [] }
      ],
      dirty: false
    }

    const newAiClips = [
      { id: 'c_new_ai', start: 50, end: 60, origin: 'ai' as const, event_ids: [] }
    ]

    const state = viewerReducer(initialState, { type: 'setAiClips', clips: newAiClips })
    expect(state.clips.length).toBe(2)
    expect(state.clips.some((c) => c.id === 'c_manual')).toBe(true)
    expect(state.clips.some((c) => c.id === 'c_old_ai')).toBe(false)
    expect(state.clips.some((c) => c.id === 'c_new_ai')).toBe(true)
  })

  it('corrections survive analysis result', () => {
    const initialState: ViewerState = {
      doc: makeTestDoc(),
      filter: new Set(),
      clips: [{ id: 'cm1', start: 1, end: 5, origin: 'manual', event_ids: [] }],
      dirty: true
    }

  // Preserve deletions/overrides from older caches; reanalysis must retain this existing data.
    initialState.doc.events[0].deleted = true
    initialState.doc.events[1].counted_override = false
    const state = viewerReducer(initialState, { type: 'addManualEvent', t: 50, eventType: 'elim' })

    // Incoming fresh analysis result
    const freshDoc = makeTestDoc()
    freshDoc.events = [
      {
        id: 'new_e1',
        t: 10.25, // |10.25 - 10| <= 1.0 -> matches e1
        type: 'knock',
        score: 0.95,
        damage_line: true,
        name_sig: null,
        counted: true,
        counted_reason: 'first',
        counted_override: null,
        source: 'auto'
      },
      {
        id: 'new_e2',
        t: 20.0, // matches e2
        type: 'knock',
        score: 0.9,
        damage_line: true,
        name_sig: null,
        counted: true,
        counted_reason: 'first',
        counted_override: null,
        source: 'auto'
      }
    ]

    const updatedState = viewerReducer(state, { type: 'analysisResult', doc: freshDoc })

    // Manual event at 50 preserved
    expect(updatedState.doc.events.some((e) => e.t === 50 && e.source === 'manual')).toBe(true)
    // Deleted state transferred to new_e1
    const newE1 = updatedState.doc.events.find((e) => e.id === 'new_e1')
    expect(newE1?.deleted).toBe(true)
    // Override state transferred to new_e2
    const newE2 = updatedState.doc.events.find((e) => e.id === 'new_e2')
    expect(newE2?.counted_override).toBe(false)
    // Manual clip preserved
    expect(updatedState.clips.some((c) => c.id === 'cm1')).toBe(true)
  })

  it('analysis result keeps a manual event once when the fresh doc already has it', () => {
    const base: ViewerState = { doc: makeTestDoc(), filter: new Set(), clips: [], dirty: false }
    const state = viewerReducer(base, { type: 'addManualEvent', t: 50, eventType: 'elim' })
    const manual = state.doc.events.find((e) => e.source === 'manual')!
    const freshDoc = makeTestDoc()
    freshDoc.events = [...freshDoc.events, { ...manual, t: 49 }]
    const merged = viewerReducer(state, { type: 'analysisResult', doc: freshDoc })
    const copies = merged.doc.events.filter((e) => e.id === manual.id)
    expect(copies).toHaveLength(1)
    expect(copies[0].t).toBe(50)
  })

  it('analysis result dedupes duplicate manual events already persisted in the old doc', () => {
    const base = makeTestDoc()
    const manual: EngineEvent = {
      id: 'dup',
      t: 30,
      type: 'elim',
      score: 1,
      damage_line: false,
      name_sig: null,
      counted: true,
      counted_reason: 'manual',
      counted_override: null,
      source: 'manual'
    }
    base.events = [...base.events, { ...manual, t: 31 }, { ...manual, t: 32 }]
    const state: ViewerState = { doc: base, filter: new Set(), clips: [], dirty: false }

    const merged = viewerReducer(state, { type: 'analysisResult', doc: makeTestDoc() })
    const copies = merged.doc.events.filter((e) => e.id === 'dup')
    expect(copies).toHaveLength(1)
    expect(copies[0].t).toBe(32)
  })

  describe('clip status actions', () => {
    const base = (): ViewerState => ({
      doc: makeTestDoc(),
      filter: new Set(),
      clips: [{ id: 'c1', start: 1, end: 5, origin: 'ai', event_ids: [], status: 'suggested' }],
      dirty: false
    })

    it('acceptClip sets accepted and dirty', () => {
      const s = viewerReducer(base(), { type: 'acceptClip', id: 'c1' })
      expect(s.clips[0].status).toBe('accepted')
      expect(s.doc.clips[0].status).toBe('accepted')
      expect(s.dirty).toBe(true)
    })

    it('skipClip / restoreClip round trip', () => {
      let s = viewerReducer(base(), { type: 'skipClip', id: 'c1' })
      expect(s.clips[0].status).toBe('skipped')
      s = viewerReducer(s, { type: 'restoreClip', id: 'c1' })
      expect(s.clips[0].status).toBe('suggested')
      expect(s.dirty).toBe(true)
    })

    it('setClips normalizes legacy clips', () => {
      const legacy = [{ id: 'x', start: 3, end: 8, origin: 'ai' }] as unknown as Clip[]
      const s = viewerReducer(base(), { type: 'setClips', clips: legacy })
      expect(s.clips[0].status).toBe('accepted')
      expect(s.doc.clips).toBe(s.clips)
    })
  })

describe('Clip status guards, reanalysis merge, and loading', () => {
    const base = (clips: Clip[] = []): ViewerState => ({
      doc: makeTestDoc(),
      filter: new Set(),
      clips,
      dirty: false
    })

    it('acceptClip/skipClip/restoreClip no-op for missing id without dirty', () => {
      const s = base([{ id: 'c1', start: 1, end: 5, origin: 'ai', event_ids: [], status: 'suggested' }])
      expect(viewerReducer(s, { type: 'acceptClip', id: 'nope' })).toBe(s)
      expect(viewerReducer(s, { type: 'skipClip', id: 'nope' })).toBe(s)
      expect(viewerReducer(s, { type: 'restoreClip', id: 'nope' })).toBe(s)
    })

    it('clip status actions no-op when already at target status (undefined counts as accepted)', () => {
      const accepted = base([{ id: 'c1', start: 1, end: 5, origin: 'ai', event_ids: [], status: 'accepted' }])
      expect(viewerReducer(accepted, { type: 'acceptClip', id: 'c1' })).toBe(accepted)

      const legacy = base([{ id: 'c1', start: 1, end: 5, origin: 'ai', event_ids: [] }])
      expect(viewerReducer(legacy, { type: 'acceptClip', id: 'c1' })).toBe(legacy)

      const suggested = base([{ id: 'c1', start: 1, end: 5, origin: 'ai', event_ids: [], status: 'suggested' }])
      expect(viewerReducer(suggested, { type: 'restoreClip', id: 'c1' })).toBe(suggested)
    })

    it('skipClip/restoreClip only apply to ai clips', () => {
      const manual = base([{ id: 'm1', start: 1, end: 5, origin: 'manual', event_ids: [], status: 'suggested' }])
      expect(viewerReducer(manual, { type: 'skipClip', id: 'm1' })).toBe(manual)
      expect(viewerReducer(manual, { type: 'restoreClip', id: 'm1' })).toBe(manual)

      const skippedManual = base([{ id: 'm1', start: 1, end: 5, origin: 'manual', event_ids: [], status: 'skipped' }])
      expect(viewerReducer(skippedManual, { type: 'restoreClip', id: 'm1' })).toBe(skippedManual)
    })

    it('reanalyze keeps accepted (marked stale), replaces suggested/skipped and adds new suggestions', () => {
      const state = base([
        { id: 'a1', start: 10, end: 20, origin: 'ai', event_ids: ['e1'], status: 'accepted' },
        { id: 's1', start: 30, end: 40, origin: 'ai', event_ids: [], status: 'suggested' },
        { id: 'k1', start: 50, end: 60, origin: 'ai', event_ids: [], status: 'skipped' },
        { id: 'm1', start: 70, end: 80, origin: 'manual', event_ids: [] }
      ])
      const fresh = makeTestDoc()
      fresh.clips = [
        { id: 'n1', start: 10.5, end: 20, origin: 'ai', event_ids: ['ne1'] }, // Less than 1 s from a1, so do not duplicate.
        { id: 'n2', start: 90, end: 100, origin: 'ai', event_ids: ['ne2'] }
      ]

      const s = viewerReducer(state, { type: 'analysisResult', doc: fresh })
      expect(s.clips.map((c) => c.id)).toEqual(['a1', 'm1', 'n2'])
      expect(s.clips.find((c) => c.id === 'a1')?.status).toBe('accepted')
      expect(s.clips.find((c) => c.id === 'a1')?.stale).toBe(true)
      expect(s.clips.find((c) => c.id === 'm1')?.status).toBe('accepted')
      expect(s.clips.find((c) => c.id === 'n2')?.status).toBe('suggested')
    })

    it('loading a doc into an empty state keeps stored clip statuses', () => {
      const fresh = makeTestDoc()
      fresh.clips = [
        { id: 'a1', start: 10, end: 20, origin: 'ai', event_ids: [], status: 'accepted' },
        { id: 's1', start: 30, end: 40, origin: 'ai', event_ids: [], status: 'suggested' },
        { id: 'm1', start: 50, end: 60, origin: 'manual', event_ids: [] }
      ]

      const s = viewerReducer(base(), { type: 'analysisResult', doc: fresh })
      expect(s.clips.map((c) => [c.id, c.status ?? 'accepted'])).toEqual([
        ['a1', 'accepted'],
        ['s1', 'suggested'],
        ['m1', 'accepted']
      ])
    })

    it('applyClips normalizes, sets dirty and updates doc', () => {
      const s = viewerReducer(base(), {
        type: 'applyClips',
        clips: [{ id: 'x', start: 3, end: 8, origin: 'ai' } as unknown as Clip]
      })
      expect(s.clips[0].status).toBe('accepted')
      expect(s.dirty).toBe(true)
      expect(s.doc.clips).toBe(s.clips)
    })
  })

})
