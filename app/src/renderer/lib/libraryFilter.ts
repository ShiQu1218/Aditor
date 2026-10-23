// Library filters (pure functions): search, favorites only, source/highlight type, and game.
import type { LibraryEntry } from '../../main/library'
import type { GameId } from '../../shared/games'

export type LibraryKind = 'all' | 'recording' | 'external' | 'hl'
export type LibraryGame = GameId | 'all'

export interface LibraryFilter {
  query: string
  favoriteOnly: boolean
  kind: LibraryKind
  game: LibraryGame
}

/**
 * Which game an entry belongs to, or null while it is still unknown.
 * Legacy entries analyzed before multi-game support have no `game`; completed ones were Apex (see `gameOf`).
 */
export function entryGame(entry: LibraryEntry): GameId | null {
  if (entry.game) return entry.game
  return entry.status === 'done' ? 'apex' : null
}

export function filterEntries(entries: LibraryEntry[], f: LibraryFilter): LibraryEntry[] {
  const needle = f.query.trim().toLowerCase()
  return entries.filter((entry) => {
    if (f.favoriteOnly && !entry.favorite) {
      return false
    }
    if (needle) {
      const filename = entry.path.split(/[/\\]/).pop()?.toLowerCase() ?? ''
      if (!filename.includes(needle)) {
        return false
      }
    }
    if (f.game !== 'all' && entryGame(entry) !== f.game) {
      return false
    }
    switch (f.kind) {
      case 'recording':
        return entry.source === 'recording'
      case 'external':
        // Legacy entries have unknown ownership and are treated like imports.
        return entry.source !== 'recording'
      case 'hl':
        return (entry.hl ?? 0) > 0
      default:
        return true
    }
  })
}
