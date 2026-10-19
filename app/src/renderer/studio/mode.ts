import type { Project, ProjectItem } from '../editor/project'

/**
 * Studio modes: source mode plays the currently open video; project mode previews project clips in sequence.
 * `sourceVideo` is the current studio source; App switches files and remounts when a clip uses another source.
 */
export interface ModeState {
  mode: 'source' | 'project'
  curItemId: string | null
  sourceVideo: string
}

export type ModeAction =
  | { type: 'playItem'; item: ProjectItem }
  | { type: 'backToSource' }
  | { type: 'seekSource' }
  | { type: 'openVideo'; path: string }

export function createMode(sourceVideo: string): ModeState {
  return { mode: 'source', curItemId: null, sourceVideo }
}

export function reduceMode(state: ModeState, action: ModeAction): ModeState {
  switch (action.type) {
    case 'playItem':
      return { ...state, mode: 'project', curItemId: action.item.id }
    case 'backToSource':
    case 'seekSource':
      return state.mode === 'source' && state.curItemId === null ? state : { ...state, mode: 'source', curItemId: null }
    case 'openVideo':
      return { mode: 'source', curItemId: null, sourceVideo: action.path }
  }
}

/** Clip currently previewed in project mode (null if not found). */
export function currentItem(state: ModeState, project: Project): ProjectItem | null {
  if (state.mode !== 'project' || !state.curItemId) return null
  return project.items.find((i) => i.id === state.curItemId) ?? null
}

/** If the previewed clip no longer exists (e.g. removed by undo), return to source mode; otherwise return the value unchanged. */
export function reconcileMode(state: ModeState, project: Project): ModeState {
  if (state.mode === 'project' && !currentItem(state, project)) {
    return { ...state, mode: 'source', curItemId: null }
  }
  return state
}
