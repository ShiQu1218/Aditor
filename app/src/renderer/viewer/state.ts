import { CacheDoc, Clip, ClipStatus, EngineEvent, EventType } from '../../shared/types'
import { mergeOnReanalyze, normalizeClips } from '../../shared/clips'

export interface ViewerState {
  doc: CacheDoc
  filter: Set<EventType>
  clips: Clip[]
  dirty: boolean
}

export type ViewerAction =
  | { type: 'addManualEvent'; t: number; eventType: EventType }
  | { type: 'setFilter'; filter: Set<EventType> }
  | { type: 'addClip'; clip: Clip }
  | { type: 'updateClip'; clip: Clip }
  | { type: 'removeClip'; id: string }
  | { type: 'setAiClips'; clips: Clip[] }
  | { type: 'acceptClip' | 'skipClip' | 'restoreClip'; id: string }
  | { type: 'setClips'; clips: Clip[] }
  | { type: 'applyClips'; clips: Clip[] }
  | { type: 'applySuggestions'; clips: Clip[] }
  | { type: 'analysisResult'; doc: CacheDoc }

export function viewerReducer(state: ViewerState, action: ViewerAction): ViewerState {
  switch (action.type) {
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

    case 'acceptClip':
    case 'skipClip':
    case 'restoreClip': {
      const status: ClipStatus =
        action.type === 'acceptClip' ? 'accepted' : action.type === 'skipClip' ? 'skipped' : 'suggested'
      const target = state.clips.find((c) => c.id === action.id)
      // 不存在的 id 或已是目標狀態：原 state（不標 dirty）
      if (!target || (target.status ?? 'accepted') === status) return state
      // 略過／復原只作用於 AI 建議；手動片段不受影響
      if (action.type !== 'acceptClip' && target.origin !== 'ai') return state
      const clips = state.clips.map((c) => (c.id === action.id ? { ...c, status } : c))
      return { ...state, clips, doc: { ...state.doc, clips }, dirty: true }
    }

    case 'setClips': {
      const clips = normalizeClips(action.clips)
      return { ...state, clips, doc: { ...state.doc, clips } }
    }

    case 'applyClips': {
      // 浮層「套用」：以合併後結果取代片段並標 dirty；使用者已自行決定建議，待重算旗標一併清除
      const clips = normalizeClips(action.clips)
      const app = state.doc.app ? { ...state.doc.app, suggestionsPending: false } : state.doc.app
      return { ...state, clips, doc: { ...state.doc, clips, app }, dirty: true }
    }

    case 'applySuggestions': {
      // 載入時的建議合併（place／merge）：套用結果並清除「重新分析後建議待重算」旗標，
      // 存檔後同一次重新分析不會再合併（也不會蓋掉使用者之後的略過）
      const clips = normalizeClips(action.clips)
      const app = state.doc.app ? { ...state.doc.app, suggestionsPending: false } : state.doc.app
      return { ...state, clips, doc: { ...state.doc, clips, app }, dirty: true }
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
      // 載入（狀態尚無片段）＝直接採用文件的片段（保留已存的 status）；
      // 重新分析＝mergeOnReanalyze：accepted 保留並標 stale、suggested／skipped 被新結果取代（spec §4.2）
      const freshAi = (freshDoc.clips || []).filter((c) => c.origin === 'ai')
      const mergedClips =
        state.clips.length === 0 ? normalizeClips(freshDoc.clips) : mergeOnReanalyze(state.clips, freshAi)

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
