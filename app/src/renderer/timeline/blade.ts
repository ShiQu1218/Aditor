export const MIN_BLADE_LENGTH = 0.5

export interface BladeState {
  enabled: boolean
  anchor: number | null
  hover: number | null
}

export type BladeAction =
  | { type: 'enable'; enabled: boolean }
  | { type: 'move' | 'click'; t: number }
  | { type: 'leave' | 'escape' }

export const initialBlade: BladeState = { enabled: false, anchor: null, hover: null }

/** Two clicks define the range; if it is too short, keep the first point, and continue slicing after completion. */
export function bladeReducer(state: BladeState, action: BladeAction): {
  state: BladeState
  range?: [number, number]
  tooShort?: boolean
} {
  if (action.type === 'enable') {
    return { state: state.enabled === action.enabled ? state : { ...initialBlade, enabled: action.enabled } }
  }
  if (!state.enabled) return { state }
  switch (action.type) {
    case 'move':
      return { state: { ...state, hover: action.t } }
    case 'leave':
      return { state: { ...state, hover: null } }
    case 'escape':
      return { state: state.anchor === null ? initialBlade : { ...state, anchor: null } }
    case 'click': {
      const t = Math.round(action.t * 1000) / 1000
      if (state.anchor === null) return { state: { ...state, anchor: t, hover: t } }
      const range: [number, number] = [Math.min(state.anchor, t), Math.max(state.anchor, t)]
      if (range[1] - range[0] < MIN_BLADE_LENGTH) return { state, tooShort: true }
      return { state: { ...state, anchor: null, hover: action.t }, range }
    }
  }
}
