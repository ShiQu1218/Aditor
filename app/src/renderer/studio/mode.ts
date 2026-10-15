import type { Project, ProjectItem } from '../editor/project'

/**
 * 工作室模式：來源模式播放目前開啟的影片；專案模式依序預覽專案片段。
 * `sourceVideo` 是「開啟的影片」，不因預覽別的來源片段而改變（spec §3.5）。
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

function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
}

/** 目前專案片段的來源 ≠ 開啟的影片（側欄與來源軌需灰化）。 */
export function isForeign(state: ModeState, project: Project): boolean {
  const item = currentItem(state, project)
  if (!item) return false
  return !samePath(item.source, state.sourceVideo)
}
