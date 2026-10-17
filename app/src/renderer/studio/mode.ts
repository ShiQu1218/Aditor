import type { Project, ProjectItem } from '../editor/project'

/**
 * 工作室模式：來源模式播放目前開啟的影片；專案模式依序預覽專案片段。
 * `sourceVideo` 是目前工作室來源；跨來源片段由 App 換檔並重新掛載。
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

/** 目前專案模式下正在預覽的片段（找不到時 null）。 */
export function currentItem(state: ModeState, project: Project): ProjectItem | null {
  if (state.mode !== 'project' || !state.curItemId) return null
  return project.items.find((i) => i.id === state.curItemId) ?? null
}

/** 預覽中的片段不存在（例如被復原移除）→ 退回來源模式；其餘原樣回傳。 */
export function reconcileMode(state: ModeState, project: Project): ModeState {
  if (state.mode === 'project' && !currentItem(state, project)) {
    return { ...state, mode: 'source', curItemId: null }
  }
  return state
}
