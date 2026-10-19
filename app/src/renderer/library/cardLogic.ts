// Pure library decision functions: card-opening behavior and layered Esc handling. No React/DOM dependency, so they can be tested independently.
import type { LibraryEntry } from '../../main/library'
import type { QueueItemState } from '../../shared/queueState'
import { i18n } from '../i18n'

export function fileName(path: string): string {
  return path.split(/[/\\]/).pop() || path
}

export function thumbnailUrl(path: string): string {
  return `file://${encodeURI(path.replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F')}`
}

/** Distinguish pending items that are not queued from items actually waiting for analysis. */
export function cardStatusText(entry: Pick<LibraryEntry, 'status'>, queueState: QueueItemState): string {
  const t = i18n.library.card
  if (entry.status === 'done') return ''
  if (entry.status === 'error') return t.error
  if (entry.status === 'analyzing') return t.analyzing
  return queueState === 'idle' ? t.notAnalyzed : t.waiting
}

export type CardActivation = 'open' | 'toast-not-analyzed' | 'toast-blocked' | 'none'

/**
 * Determine what happens when the main button (.vcard-open) is activated (click/Enter/Space).
 * Only done items open; processing/waiting items show a toast (items not yet queued show "not analyzed"); error items do nothing (use Retry on the card).
 * Inner buttons (favorite, ⋯, retry, remove) are siblings of the main button and do not pass through here.
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

/** Handle Esc (after keymap's IME check) by topmost priority: card menu → search text → no action. */
export function resolveLibraryEscape(state: { menuOpen: boolean; query: string }): EscapeAction {
  if (state.menuOpen) return 'close-menu'
  if (state.query !== '') return 'clear-query'
  return 'none'
}
