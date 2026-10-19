import type { AutoClipParams, Clip } from '../../shared/types'

/**
 * Estimate state machine for the AI auto-clip popover (pure functions):
 * keep the estimate and applicable clips in the same state object, along with the parameters used to calculate them;
 * discard stale responses by sequence number, and make old results inapplicable as soon as parameters change (spec §3.2.4).
 */
export interface EstimateState {
  status: 'idle' | 'loading' | 'ready' | 'error'
/** Parameters associated with the current result or in-flight request. */
  params: AutoClipParams | null
/** Latest request sequence; discard any response with a different sequence. */
  seq: number
  clips: Clip[]
}

export const initialEstimate: EstimateState = { status: 'idle', params: null, seq: 0, clips: [] }

export type EstimateAction =
  | { type: 'request'; seq: number; params: AutoClipParams }
  | { type: 'resolve'; seq: number; clips: Clip[] }
  | { type: 'reject'; seq: number }

export function estimateReducer(state: EstimateState, action: EstimateAction): EstimateState {
  switch (action.type) {
    case 'request':
      return { status: 'loading', params: action.params, seq: action.seq, clips: [] }
    case 'resolve':
      if (action.seq !== state.seq) return state
      return { ...state, status: 'ready', clips: action.clips }
    case 'reject':
      if (action.seq !== state.seq) return state
      return { ...state, status: 'error', clips: [] }
  }
}

export function paramsEqual(a: AutoClipParams | null, b: AutoClipParams | null): boolean {
  if (!a || !b) return false
  return a.n === b.n && a.gap === b.gap && a.before === b.before && a.after === b.after && a.max_len === b.max_len
}

/** Whether the current inputs match the computed result (only a match can be applied). */
export function canApply(state: EstimateState, current: AutoClipParams): boolean {
  return state.status === 'ready' && paramsEqual(state.params, current)
}

/** Estimate for display (null when mismatched, calculating, or failed; display "Calculating…"). */
export function estimateView(state: EstimateState, current: AutoClipParams): { n: number; total: number } | null {
  if (!canApply(state, current)) return null
  return {
    n: state.clips.length,
    total: state.clips.reduce((sum, c) => sum + Math.max(0, c.end - c.start), 0)
  }
}
