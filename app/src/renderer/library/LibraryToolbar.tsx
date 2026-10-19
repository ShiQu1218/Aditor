import React from 'react'
import { Search, Star } from '../components/icons'
import type { LibraryKind } from '../lib/libraryFilter'
import { i18n } from '../i18n'

const t = i18n.library

export interface LibraryToolbarProps {
  query: string
  onQueryChange: (q: string) => void
  favoriteOnly: boolean
  onToggleFavorite: () => void
  kind: LibraryKind
  onKindChange: (k: LibraryKind) => void
  /** 各篩選（不計搜尋字串）的影片數 */
  counts: Record<LibraryKind, number>
  searchRef: React.RefObject<HTMLInputElement>
}

export function LibraryToolbar({
  query,
  onQueryChange,
  favoriteOnly,
  onToggleFavorite,
  kind,
  onKindChange,
  counts,
  searchRef
}: LibraryToolbarProps): JSX.Element {
  const chip = (k: LibraryKind, label: string, extra?: JSX.Element): JSX.Element => (
    <button
      type="button"
      className={`lib-chip${kind === k ? ' on' : ''}`}
      aria-pressed={kind === k}
      onClick={() => onKindChange(k)}
    >
      {extra}
      {label}
      <span className="n">{counts[k]}</span>
    </button>
  )

  return (
    <div className="lib-tools">
      <div className="search">
        <Search className="ic" />
        <input
          ref={searchRef}
          type="search"
          placeholder={t.searchPlaceholder}
          aria-label={t.searchPlaceholder}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
        />
        <kbd>Ctrl F</kbd>
      </div>
      <span className="sep" />
      <button
        type="button"
        className={`lib-chip${kind === 'all' && !favoriteOnly ? ' on' : ''}`}
        aria-pressed={kind === 'all' && !favoriteOnly}
        onClick={() => {
          onKindChange('all')
          if (favoriteOnly) onToggleFavorite()
        }}
      >
        {t.chips.all}
        <span className="n">{counts.all}</span>
      </button>
      <button
        type="button"
        className={`lib-chip${favoriteOnly ? ' on' : ''}`}
        aria-pressed={favoriteOnly}
        onClick={onToggleFavorite}
      >
        <Star className="ic sm" />
        {t.chips.favorite}
        <kbd>Ctrl D</kbd>
      </button>
      {chip('knock', t.chips.knock)}
      {chip('assist', t.chips.assist)}
      {chip('hl', t.chips.hl, <span className="lib-pill accent lib-slant">{t.chips.isNew}</span>)}
    </div>
  )
}
