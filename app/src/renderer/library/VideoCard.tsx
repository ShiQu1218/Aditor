import React, { useEffect, useId, useRef, useState } from 'react'
import type { LibraryEntry } from '../../main/library'
import type { VideoInfo } from '../../shared/types'
import { formatTime } from '../../shared/time'
import { formatEta } from '../../shared/eta'
import { containerCodecSupported } from '../media/playability'
import { useQueueEta, useQueueItemState } from '../queue/QueueProvider'
import { i18n } from '../i18n'
import { nextTrapIndex } from '../a11y/focusTrap'
import { rovingStep } from '../a11y/roving'
import { AlertTriangle, ImageOff, MoreHorizontal, RefreshCw, Star, Trash2 } from '../components/icons'
import { cardStatusText, fileName, thumbnailUrl } from './cardLogic'
import { GAMES, GAME_IDS, gameOf, type GameId } from '../../shared/games'

export { fileName } from './cardLogic'

const t = i18n.library.card

export interface VideoCardProps {
  entry: LibraryEntry
  /** Report any click/Enter; the caller decides whether to open or show a toast. */
  onOpen: (entry: LibraryEntry) => void
  onToggleFavorite: (path: string) => void
  onRemove: (path: string) => void
  onRetry: (path: string) => void
  /** The user picks the game after recognition failed; main records it and analyzes the video again. */
  onSetGame?: (path: string, game: GameId) => void
  /** Report when the card menu opens/closes (include a close function when opening); keymap handles Esc in menu-then-search order. */
  onMenuChange?: (path: string, close: (() => void) | null) => void
  /** Proxy suggestion setting: hide the proxy-suggestion badge when false (defaults to true). */
  proxySuggest?: boolean
  /**
   * Roving tabindex: only controls in the cursor card participate in the grid's Tab order (others use tabIndex=-1 but remain reachable by mouse/arrow keys).
   * Defaults to true when used without a grid.
   */
  active?: boolean
}

  /**
   * Top-left proxy-suggestion badge: always show for AV1 (hardware decoding is uncommon);
   * also show for containers/codecs Chromium cannot play. The studio notice performs the definitive playback/hardware-decoding check.
   */
export function proxyBadge(entry: LibraryEntry): string | null {
  const codec = (entry.codec ?? '').toLowerCase()
  if (!codec) return null
  if (codec === 'av1' || codec === 'av01') return t.av1
  const container = entry.path.split('.').pop() ?? ''
  if (!containerCodecSupported({ codec } as VideoInfo, container)) return t.proxySuggest
  return null
}

  /** Fields that trigger a card rerender (progress is separately throttled to 2 Hz). */
export function sameCardEntry(a: LibraryEntry, b: LibraryEntry): boolean {
  return (
    a.path === b.path &&
    a.status === b.status &&
    a.progress === b.progress &&
    a.analyzingSince === b.analyzingSince &&
    a.favorite === b.favorite &&
    a.error === b.error &&
    a.errorCode === b.errorCode &&
    a.game === b.game &&
    a.hl === b.hl &&
    a.durationSec === b.durationSec &&
    a.thumb === b.thumb &&
    a.codec === b.codec &&
    a.counts?.knock === b.counts?.knock &&
    a.counts?.assist === b.counts?.assist &&
    a.counts?.kill === b.counts?.kill &&
    a.counts?.death === b.counts?.death
  )
}

function VideoCardView({ entry, onOpen, onToggleFavorite, onRemove, onRetry, onSetGame, onMenuChange, proxySuggest = true, active = true }: VideoCardProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const rootRef = useRef<HTMLElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  /** Whether focus is inside the menu while open; used on close to decide whether to return focus to the ⋯ button. */
  const menuHadFocus = useRef(false)
  const moreId = useId()
  const tab = active ? 0 : -1
  const name = fileName(entry.path)
  const title = name.replace(/\.[^.]+$/, '')
  const badge = proxySuggest ? proxyBadge(entry) : null
  const done = entry.status === 'done'
  const error = entry.status === 'error'
  const unknownGame = error && entry.errorCode === 'unknown_game'
  // Waiting refers only to main's real queue; pending items not in the queue (imported but not queued, or canceled) are not analyzed yet.
  const queueState = useQueueItemState(entry.path)
  const notQueued = entry.status === 'pending' && queueState === 'idle'
  const statusText = cardStatusText(entry, queueState)
  const eta = useQueueEta(entry.path)

  useEffect(() => {
    if (!menuOpen) return
    onMenuChange?.(entry.path, () => setMenuOpen(false))
    const close = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => {
      window.removeEventListener('mousedown', close)
      onMenuChange?.(entry.path, null)
    }
  }, [menuOpen, entry.path, onMenuChange])

  // On open, move focus to the first option; on close, return focus to the ⋯ trigger if focus was inside the menu.
  useEffect(() => {
    if (!menuOpen) return
    const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')
    first?.focus()
    menuHadFocus.current = first !== undefined && first !== null
    return () => {
      if (menuHadFocus.current) moreRef.current?.focus()
      menuHadFocus.current = false
    }
  }, [menuOpen])

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
    const at = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      items[nextTrapIndex(items.length, at, e.key === 'ArrowUp')]?.focus()
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      const i = rovingStep({ count: items.length, index: at, key: e.key, columns: 1, orientation: 'vertical' })
      if (i !== null) items[i]?.focus()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation() // Close only the menu; do not also let the library's Esc handler clear search.
      setMenuOpen(false)
    } else if (e.key === 'Tab') {
      // Do not intercept Tab in the menu: close it and let focus continue from the ⋯ button.
      menuHadFocus.current = false
      moreRef.current?.focus()
      setMenuOpen(false)
    }
  }

  // Lazy "N highlights" (spec §7.4): when a card first enters the viewport after analysis and has no record, ask main to calculate with default parameters.
  const wantHl = done && entry.hl === undefined
  useEffect(() => {
    if (!wantHl) return
    const el = rootRef.current
    if (!el) return
    let requested = false
    const request = (): void => {
      if (requested) return
      requested = true
      void window.api?.library?.computeHl?.(entry.path)
    }
    if (typeof IntersectionObserver === 'undefined') {
      request()
      return
    }
    const io = new IntersectionObserver((observed) => {
      if (observed.some((o) => o.isIntersecting)) {
        request()
        io.disconnect()
      }
    })
    io.observe(el)
    return () => io.disconnect()
  }, [wantHl, entry.path])

  const label = statusText ? `${title} · ${statusText}` : title

// Structure: the <article> (no role or keyboard handling) contains one main .vcard-open button (thumbnail and text, used to open),
// with all other controls (favorite, ⋯, analyze, retry, remove) as siblings, never nested; native <button> handles Enter/Space.
  return (
    <article ref={rootRef} className={`vcard${error ? ' err' : ''}${done ? '' : ' busy'}`} data-vcard-path={entry.path}>
      <button
        type="button"
        className="vcard-open"
        aria-label={label}
        aria-disabled={!done}
        tabIndex={tab}
        onClick={() => onOpen(entry)}
      >
        <span className="vcard-thumb">
          {entry.thumb ? (
            <img src={thumbnailUrl(entry.thumb)} alt="" loading="lazy" decoding="async" />
          ) : (
            <span className="vcard-nothumb">
              <ImageOff className="ic lg" />
              <span>{t.noThumb}</span>
            </span>
          )}

          {badge && <span className="lib-pill warn vcard-badge">{badge}</span>}

          {done && (
            <span className="vcard-counts">
              {(entry.counts?.knock ?? 0) > 0 && (
                <span className="vbadge knock">{t.knockBadge.replace('{n}', String(entry.counts?.knock ?? 0))}</span>
              )}
              {(entry.counts?.assist ?? 0) > 0 && (
                <span className="vbadge assist">{t.assistBadge.replace('{n}', String(entry.counts?.assist ?? 0))}</span>
              )}
              {(entry.counts?.kill ?? 0) > 0 && (
                <span className="vbadge knock">{t.killBadge.replace('{n}', String(entry.counts?.kill ?? 0))}</span>
              )}
              {(entry.counts?.death ?? 0) > 0 && (
                <span className="vbadge death">{t.deathBadge.replace('{n}', String(entry.counts?.death ?? 0))}</span>
              )}
              {(entry.hl ?? 0) > 0 && <span className="vbadge hl">{t.hlCount.replace('{n}', String(entry.hl))}</span>}
            </span>
          )}

          {entry.durationSec ? <span className="vcard-dur mono">{formatTime(entry.durationSec)}</span> : null}

          {entry.status === 'pending' && !notQueued && (
            <span className="vcard-overlay" role="status">
              <span>
                {t.waiting}
                <small>{t.waitingQueue}</small>
              </span>
            </span>
          )}
          {notQueued && (
            <span className="vcard-overlay" role="status">
              <span>
                {t.notAnalyzed}
                <small>{t.notAnalyzedHint}</small>
              </span>
            </span>
          )}
          {entry.status === 'analyzing' && (
            <>
              <span className="vcard-overlay" role="status">
                <span>
                  {t.progressText.replace('{n}', String(Math.round((entry.progress ?? 0) * 100)))}
                  {eta != null ? ` · ${formatEta(eta)}` : ''}
                  <small>{t.openBlocked}</small>
                </span>
              </span>
              <span className="vcard-progress">
                <i style={{ width: `${Math.round((entry.progress ?? 0) * 100)}%` }} />
              </span>
            </>
          )}
        </span>

        <span className="vcard-body">
          <span className="vcard-name" title={name}>
            {title}
          </span>
          {error ? (
            <span className="vcard-error-reason" title={entry.error}>
              <AlertTriangle className="ic sm" />
              <span>{unknownGame ? t.unknownGame : entry.error || t.error}</span>
            </span>
          ) : (
            <span className="vcard-meta">
              <span>{new Date(entry.addedAt).toLocaleString('zh-TW', { hour12: false })}</span>
              {entry.codec ? <span className="vcard-codec">{entry.codec.toUpperCase()}</span> : null}
            </span>
          )}
        </span>
      </button>

      <button
        type="button"
        className={`vcard-fav${entry.favorite ? ' on' : ''}`}
        aria-label={entry.favorite ? t.favoriteRemove : t.favoriteAdd}
        aria-pressed={entry.favorite}
        tabIndex={tab}
        onClick={() => onToggleFavorite(entry.path)}
      >
        <Star className="ic" fill={entry.favorite ? 'currentColor' : 'none'} />
      </button>

      {notQueued && (
        <button type="button" className="lib-btn sm primary vcard-analyze" tabIndex={tab} onClick={() => onRetry(entry.path)}>
          {t.analyze}
        </button>
      )}

      {error && (
        <div className="vcard-error-actions">
          {unknownGame && onSetGame ? (
            GAME_IDS.map((game) => (
              <button key={game} type="button" className="lib-btn sm primary" tabIndex={tab} onClick={() => onSetGame(entry.path, game)}>
                {GAMES[game].displayName}
              </button>
            ))
          ) : (
            <button type="button" className="lib-btn sm" tabIndex={tab} onClick={() => onRetry(entry.path)}>
              {t.retry}
            </button>
          )}
          <button type="button" className="lib-btn sm" tabIndex={tab} onClick={() => onRemove(entry.path)}>
            {t.remove}
          </button>
        </div>
      )}

      <div className="vcard-menu-wrap">
        <button
          type="button"
          ref={moreRef}
          id={moreId}
          className="vcard-more"
          aria-label={t.more}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          tabIndex={tab}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <MoreHorizontal className="ic" />
        </button>
        {menuOpen && (
          <div className="vcard-menu" role="menu" aria-labelledby={moreId} ref={menuRef} onKeyDown={onMenuKeyDown}>
            {(done || error) && (
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  setMenuOpen(false)
                  onRetry(entry.path)
                }}
              >
                <RefreshCw className="ic sm" />
                {t.reanalyze}
              </button>
            )}
            {(done || error) && onSetGame && !unknownGame && GAME_IDS.filter((game) => game !== gameOf(entry.game)).map((game) => (
              <button
                key={game}
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  setMenuOpen(false)
                  onSetGame(entry.path, game)
                }}
              >
                <RefreshCw className="ic sm" />
                {t.analyzeAs.replace('{game}', GAMES[game].displayName)}
              </button>
            ))}
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                setMenuOpen(false)
                onRemove(entry.path)
              }}
            >
              <Trash2 className="ic sm" />
              {t.remove}
            </button>
          </div>
        )}
      </div>
    </article>
  )
}

export const VideoCard = React.memo(VideoCardView, (a, b) => sameCardEntry(a.entry, b.entry) && (a.proxySuggest ?? true) === (b.proxySuggest ?? true) && (a.active ?? true) === (b.active ?? true))
