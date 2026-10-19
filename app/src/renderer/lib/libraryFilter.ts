// Library filters (pure functions): search, favorites only, and event/highlight type.
import type { LibraryEntry } from '../../main/library'

export type LibraryKind = 'all' | 'knock' | 'assist' | 'hl'

export interface LibraryFilter {
  query: string
  favoriteOnly: boolean
  kind: LibraryKind
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
    switch (f.kind) {
      case 'knock':
        return (entry.counts?.knock ?? 0) > 0
      case 'assist':
        return (entry.counts?.assist ?? 0) > 0
      case 'hl':
        return (entry.hl ?? 0) > 0
      default:
        return true
    }
  })
}
