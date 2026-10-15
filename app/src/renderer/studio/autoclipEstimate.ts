import type { AutoClipParams, Clip } from '../../shared/types'

/**
 * AI 自動剪輯浮層的預估狀態機（純函式）：
 * 預估數字與可套用的片段綁在同一個狀態物件裡，並記錄它是用哪組參數算的；
 * 以序號丟棄過期回應，參數一改舊結果就不可套用（spec §3.2.4）。
 */
export interface EstimateState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** 目前這份結果（或進行中請求）對應的參數 */
  params: AutoClipParams | null
  /** 最新請求序號；序號不符的回應一律丟棄 */
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

/** 目前輸入的參數是否與已算好的結果一致（一致才可套用）。 */
export function canApply(state: EstimateState, current: AutoClipParams): boolean {
  return state.status === 'ready' && paramsEqual(state.params, current)
}

/** 顯示用預估（不一致、計算中或失敗＝null → 顯示「計算中…」）。 */
export function estimateView(state: EstimateState, current: AutoClipParams): { n: number; total: number } | null {
  if (!canApply(state, current)) return null
  return {
    n: state.clips.length,
    total: state.clips.reduce((sum, c) => sum + Math.max(0, c.end - c.start), 0)
  }
}
