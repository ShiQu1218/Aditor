// 影片庫的純決策函式：卡片開啟行為與 Esc 的分層關閉。不依賴 React／DOM，便於單獨測試。
import type { LibraryEntry } from '../../main/library'
import type { QueueItemState } from '../../shared/queueState'
import { i18n } from '../i18n/zh-TW'

export function fileName(path: string): string {
  return path.split(/[/\\]/).pop() || path
}

export function thumbnailUrl(path: string): string {
  return `file://${encodeURI(path.replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F')}`
}

/** 未排隊的 pending 與真正等待分析的項目分開顯示。 */
export function cardStatusText(entry: Pick<LibraryEntry, 'status'>, queueState: QueueItemState): string {
  const t = i18n.library.card
  if (entry.status === 'done') return ''
  if (entry.status === 'error') return t.error
  if (entry.status === 'analyzing') return t.analyzing
  return queueState === 'idle' ? t.notAnalyzed : t.waiting
}

export type CardActivation = 'open' | 'toast-not-analyzed' | 'toast-blocked' | 'none'

/**
 * 主要按鈕（.vcard-open）被啟動（點擊／Enter／Space）時要做什麼。
 * 只有 done 能開；分析中／等待中顯示 Toast（尚未排入佇列者用「尚未分析」提示）；error 什麼都不做（用卡片上的〔重試〕）。
 * 內部按鈕（收藏、⋯、重試、移除）是主要按鈕的兄弟元素，不會經過這裡。
 */
export function resolveCardActivation(
  entry: Pick<LibraryEntry, 'status'>,
  queueState: 'idle' | 'queued' | 'analyzing'
): CardActivation {
  if (entry.status === 'done') return 'open'
  if (entry.status === 'error') return 'none'
  return queueState === 'idle' ? 'toast-not-analyzed' : 'toast-blocked'
}

export type EscapeAction = 'close-menu' | 'clear-query' | 'none'

/** Esc（已通過 keymap 的 IME 檢查）依最上層優先：卡片選單 → 搜尋字串 → 無動作。 */
export function resolveLibraryEscape(state: { menuOpen: boolean; query: string }): EscapeAction {
  if (state.menuOpen) return 'close-menu'
  if (state.query !== '') return 'clear-query'
  return 'none'
}
