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
  it('deleteEvent marks deleted, keeps event', () => {
    const initialState: ViewerState = {
      doc: makeTestDoc(),
      selected: new Set(),
      filter: new Set<EventType>(['knock', 'assist_knock', 'assist_elim', 'elim', 'squad_wipe']),
      clips: [],
      dirty: false
    }

    const state = viewerReducer(initialState, { type: 'deleteEvent', id: 'e1' })
    expect(state.doc.events.length).toBe(2)
    const e1 = state.doc.events.find((e) => e.id === 'e1')
    expect(e1?.deleted).toBe(true)
    expect(state.dirty).toBe(true)
  })

  it('addManualEvent creates manual event with null sig', () => {
    const initialState: ViewerState = {
      doc: makeTestDoc(),
      selected: new Set(),
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

  it('setOverride cycles true/false/null', () => {
    const initialState: ViewerState = {
      doc: makeTestDoc(),
      selected: new Set(),
      filter: new Set(),
      clips: [],
      dirty: false
    }

    let state = viewerReducer(initialState, { type: 'setOverride', id: 'e1', value: true })
    expect(state.doc.events[0].counted_override).toBe(true)

    state = viewerReducer(state, { type: 'setOverride', id: 'e1', value: false })
    expect(state.doc.events[0].counted_override).toBe(false)

    state = viewerReducer(state, { type: 'setOverride', id: 'e1', value: null })
    expect(state.doc.events[0].counted_override).toBeNull()
  })

  it('setAiClips replaces only ai clips', () => {
    const initialState: ViewerState = {
      doc: makeTestDoc(),
      selected: new Set(),
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
      selected: new Set(),
      filter: new Set(),
      clips: [{ id: 'cm1', start: 1, end: 5, origin: 'manual', event_ids: [] }],
      dirty: true
    }

    // User modified e1 (t=10): deleted it, and added manual event at t=50
    let state = viewerReducer(initialState, { type: 'deleteEvent', id: 'e1' })
    state = viewerReducer(state, { type: 'setOverride', id: 'e2', value: false })
    state = viewerReducer(state, { type: 'addManualEvent', t: 50, eventType: 'elim' })

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

  describe('clip status actions', () => {
    const base = (): ViewerState => ({
      doc: makeTestDoc(),
      selected: new Set(),
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

    it('restoreEvent undeletes and marks dirty', () => {
      const b = base()
      let s = viewerReducer(b, { type: 'deleteEvent', id: 'e1' })
      s = { ...s, dirty: false }
      s = viewerReducer(s, { type: 'restoreEvent', id: 'e1' })
      expect(s.doc.events.find((e) => e.id === 'e1')?.deleted).toBeFalsy()
      expect(s.dirty).toBe(true)
    })

    it('setClips normalizes legacy clips', () => {
      const legacy = [{ id: 'x', start: 3, end: 8, origin: 'ai' }] as unknown as Clip[]
      const s = viewerReducer(base(), { type: 'setClips', clips: legacy })
      expect(s.clips[0].status).toBe('accepted')
      expect(s.doc.clips).toBe(s.clips)
    })
  })
})
