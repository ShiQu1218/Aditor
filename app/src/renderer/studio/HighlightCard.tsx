import { forwardRef } from 'react'
import type { Clip, EngineEvent } from '../../shared/types'
import { formatTime } from '../../shared/time'
import { Check, Play, Plus, Undo2 } from '../components/icons'
import { i18n } from '../i18n'
import { clipEventGlyphs, clipTitle } from './highlights'
import { tr } from '../../shared/locale'

export interface HighlightCardProps {
  clip: Clip
  /** Events in the current video (used for the title count and glyph row). */
  events: EngineEvent[]
  /** Large-card mode (16:9 thumbnail card). */
  big: boolean
  /** Active card (roving tabindex). */
  active: boolean
  /** Clicking a card previews it and makes it active. */
  onSelect: (clip: Clip) => void
  onPreview: (clip: Clip) => void
  onAccept: (clip: Clip) => void
  onSkip: (clip: Clip) => void
  onRestore: (clip: Clip) => void
  onRemove: (clip: Clip) => void
  /** Make the card active when focus enters it (including an inner button); do not preview or seek. */
  onFocusCard: (clip: Clip) => void
}

  /**
   * Highlight card (spec §3.2.3): compact mode uses a 128×84 thumbnail and text; large mode uses 16:9.
   * The list row itself must not be a `<button>` (keymap rule), so it uses a div with roving tabindex.
   */
export const HighlightCard = forwardRef<HTMLDivElement, HighlightCardProps>(function HighlightCard(
  { clip, events, big, active, onSelect, onPreview, onAccept, onSkip, onRestore, onRemove, onFocusCard },
  ref
) {
  const t = i18n.studio.hl
  const status = clip.status ?? 'accepted'
  const title = clipTitle(clip, events)
  const { glyphs, overflow } = clipEventGlyphs(clip, events)
  const len = Math.max(0, clip.end - clip.start)
  const badge =
    clip.origin === 'manual' ? t.badgeManual : status === 'suggested' ? t.badgeSuggested : t.badgeAccepted
  const timeLabel = `${formatTime(clip.start)}–${formatTime(clip.end)}`
  // Roving tabindex: only buttons in the active card are in the Tab order (others remain clickable by mouse).
  const inner = active ? 0 : -1

  return (
    <div
      ref={ref}
      role="listitem"
      tabIndex={active ? 0 : -1}
      className={`hl-card${big ? ' big' : ''}${status === 'skipped' ? ' skipped' : ''}${active ? ' active' : ''}`}
      aria-label={tr('{title}，{timeLabel}', { title, timeLabel })}
      data-clip-id={clip.id}
      onClick={() => onSelect(clip)}
      onFocus={() => onFocusCard(clip)}
    >
      <div className="hl-thumb" aria-hidden="true">
        <span className={`hl-badge ${clip.origin === 'manual' ? 'manual' : status}`}>{badge}</span>
        <span className="hl-dur mono">{formatTime(len)}</span>
      </div>

      <div className="hl-body">
        <div className="hl-head">
          <span className="hl-title">{title}</span>
          <span className="hl-time mono dim">{timeLabel}</span>
        </div>
        {clip.stale && <div className="hl-sub dim">{t.stale}</div>}
        <div className="hl-glyphs" aria-hidden="true">
          {glyphs.map((g, i) => (
            <span key={i} className={`hl-glyph${g.counted ? '' : ' uncounted'}`} data-type={g.type} />
          ))}
          {overflow > 0 && <span className="hl-more dim">+{overflow}</span>}
        </div>

        <div className="hl-actions">
          {status === 'suggested' && (
            <>
              <button
                type="button"
                tabIndex={inner}
                className="icon-btn hl-preview"
                aria-label={t.preview}
                onClick={(e) => {
                  e.stopPropagation()
                  onPreview(clip)
                }}
              >
                <Play className="ic sm" />
              </button>
              <div className="hl-actions-spacer" />
              <button
                type="button"
                tabIndex={inner}
                className="btn-ghost hl-skip"
                onClick={(e) => {
                  e.stopPropagation()
                  onSkip(clip)
                }}
              >
                {t.skip}
              </button>
              <button
                type="button"
                tabIndex={inner}
                className="btn-accent hl-accept"
                onClick={(e) => {
                  e.stopPropagation()
                  onAccept(clip)
                }}
              >
                <Plus className="ic sm" />
                {t.accept}
              </button>
            </>
          )}

          {status === 'accepted' && (
            <>
              <span className="hl-accepted">
                <Check className="ic sm" />
                {t.accepted}
              </span>
              <div className="hl-actions-spacer" />
              <button
                type="button"
                tabIndex={inner}
                className="btn-ghost hl-remove"
                onClick={(e) => {
                  e.stopPropagation()
                  onRemove(clip)
                }}
              >
                {t.remove}
              </button>
            </>
          )}

          {status === 'skipped' && (
            <button
              type="button"
              tabIndex={inner}
              className="btn-ghost hl-restore"
              onClick={(e) => {
                e.stopPropagation()
                onRestore(clip)
              }}
            >
              <Undo2 className="ic sm" />
              {t.restore}
            </button>
          )}
        </div>
      </div>
    </div>
  )
})
