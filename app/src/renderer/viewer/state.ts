import { CacheDoc, Clip, EngineEvent, EventType } from '../../shared/types'

export interface ViewerState {
  doc: CacheDoc
  selected: Set<string>
  filter: Set<EventType>
  clips: Clip[]
  dirty: boolean
}

export type ViewerAction =
  | { type: 'deleteEvent'; id: string }
  | { type: 'addManualEvent'; t: number; eventType: EventType }
  | { type: 'setOverride'; id: string; value: boolean | null }
  | { type: 'toggleSelectEvent'; id: string }
  | { type: 'setFilter'; filter: Set<EventType> }
  | { type: 'addClip'; clip: Clip }
  | { type: 'updateClip'; clip: Clip }
  | { type: 'removeClip'; id: string }
  | { type: 'setAiClips'; clips: Clip[] }
  | { type: 'derived'; events: EngineEvent[] }
  | { type: 'analysisResult'; doc: CacheDoc }

export function viewerReducer(state: ViewerState, action: ViewerAction): ViewerState {
  switch (action.type) {
    case 'deleteEvent': {
      const events = state.doc.events.map((e) => {
        if (e.id === action.id) {
          return { ...e, deleted: true }
        }
        return e
      })
      return {
        ...state,
        doc: { ...state.doc, events },
        dirty: true
      }
    }

    case 'addManualEvent': {
      const newEvent: EngineEvent = {
        id: `m${Date.now()}`,
        t: action.t,
        type: action.eventType,
        score: 1.0,
        damage_line: false,
        name_sig: null,
        counted: true,
        counted_reason: 'manual',
        counted_override: null,
        source: 'manual'
      }
      const events = [...state.doc.events, newEvent].sort((a, b) => a.t - b.t)
      return {
        ...state,
        doc: { ...state.doc, events },
        dirty: true
      }
    }

    case 'setOverride': {
      const events = state.doc.events.map((e) => {
        if (e.id === action.id) {
          return { ...e, counted_override: action.value }
        }
        return e
      })
      return {
        ...state,
        doc: { ...state.doc, events },
        dirty: true
      }
    }

    case 'toggleSelectEvent': {
      const nextSelected = new Set(state.selected)
      if (nextSelected.has(action.id)) {
        nextSelected.delete(action.id)
      } else {
        nextSelected.add(action.id)
      }
      return {
        ...state,
        selected: nextSelected
      }
    }

    case 'setFilter': {
      return {
        ...state,
        filter: new Set(action.filter)
      }
    }

    case 'addClip': {
      const clips = [...state.clips, action.clip].sort((a, b) => a.start - b.start)
      return {
        ...state,
        clips,
        doc: { ...state.doc, clips },
        dirty: true
      }
    }

    case 'updateClip': {
      const clips = state.clips.map((c) => (c.id === action.clip.id ? action.clip : c))
      return {
        ...state,
        clips,
        doc: { ...state.doc, clips },
        dirty: true
      }
    }

    case 'removeClip': {
      const clips = state.clips.filter((c) => c.id !== action.id)
      return {
        ...state,
        clips,
        doc: { ...state.doc, clips },
        dirty: true
      }
    }

    case 'setAiClips': {
      const manualClips = state.clips.filter((c) => c.origin === 'manual')
      const clips = [...manualClips, ...action.clips].sort((a, b) => a.start - b.start)
      return {
        ...state,
        clips,
        doc: { ...state.doc, clips },
        dirty: true
      }
    }

    case 'derived': {
      return {
        ...state,
        doc: { ...state.doc, events: action.events }
      }
    }

    case 'analysisResult': {
      // Merge local manual events and user corrections (deleted, counted_override)
      const oldDoc = state.doc
      const freshDoc = action.doc

      const manualEvents = oldDoc.events.filter((e) => e.source === 'manual')
      const oldUserAutoEvents = oldDoc.events.filter(
        (e) => e.source === 'auto' && (e.deleted || e.counted_override !== null)
      )

      const updatedFreshEvents = freshDoc.events.map((fe) => {
        // Find nearest old auto event with same type and |t - fe.t| <= 1.0
        let nearest: EngineEvent | null = null
        let minDist = Infinity
        for (const oe of oldUserAutoEvents) {
          if (oe.type === fe.type && Math.abs(oe.t - fe.t) <= 1.0) {
            const dist = Math.abs(oe.t - fe.t)
            if (dist < minDist) {
              minDist = dist
              nearest = oe
            }
          }
        }

        if (nearest) {
          return {
            ...fe,
            deleted: nearest.deleted,
            counted_override: nearest.counted_override
          }
        }
        return fe
      })

      const mergedEvents = [...updatedFreshEvents, ...manualEvents].sort((a, b) => a.t - b.t)
      const manualClips = state.clips.filter((c) => c.origin === 'manual')
      const mergedClips = [...manualClips, ...(freshDoc.clips || []).filter((c) => c.origin === 'ai')]

      return {
        ...state,
        doc: {
          ...freshDoc,
          events: mergedEvents,
          clips: mergedClips
        },
        clips: mergedClips,
        dirty: false
      }
    }

    default:
      return state
  }
}
