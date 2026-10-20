import React, { useEffect, useRef, useState } from 'react'
import type { Clip, EngineEvent } from '../../shared/types'
import { formatTime } from '../../shared/time'
import { suggestionCount } from '../../shared/clips'
import { totalDuration, type Project } from '../editor/project'
import { rovingStep } from '../a11y/roving'
import { i18n } from '../i18n'
import { HighlightCard } from './HighlightCard'

export interface HighlightsTabProps {
  clips: Clip[]
  events: EngineEvent[]
  /** Active card (target of keymap Enter/Delete/↑↓). */
  activeId: string | null
  onActiveChange: (id: string | null) => void
  onPreview: (clip: Clip) => void
  onAccept: (clip: Clip) => void
  onSkip: (clip: Clip) => void
  onRestore: (clip: Clip) => void
  onRemove: (clip: Clip) => void
  /** Adjust AI settings action in the empty state. */
  onTuneParams: () => void
  project: Project
  onAddAll: () => void
}

  /**
   * Highlights tab (spec §3.2.3): compact/large toggle, card list (role=list, roving tabindex),
   * and footer with project clip count/duration plus Add All (Ctrl+E).
   */
export function HighlightsTab({
  clips,
  events,
  activeId,
  onActiveChange,
  onPreview,
  onAccept,
  onSkip,
  onRestore,
  onRemove,
  onTuneParams,
  project,
  onAddAll
}: HighlightsTabProps): JSX.Element {
  const t = i18n.studio.hl
  const [big, setBig] = useState(false)
  const cardRefs = useRef(new Map<string, HTMLDivElement>())

// Move focus when the active card changes only if focus was already in the list or nowhere (body),
// so arrow navigation or initial focus on the first card does not steal focus from the timeline/player.
  useEffect(() => {
    if (!activeId) return
    const el = cardRefs.current.get(activeId)
    if (!el) return
    // Always keep the active card visible (e.g. it follows the playhead), even when focus stays elsewhere.
    el.scrollIntoView?.({ block: 'nearest' })
    const focused = document.activeElement as HTMLElement | null
    if (focused && el.contains(focused)) return // Focus is already inside this card (e.g. an inner button was just pressed); do not steal it.
    const inHl = typeof focused?.closest === 'function' && focused.closest('[data-zone="hl"]') !== null
    if (inHl || focused === document.body || focused === null) el.focus()
  }, [activeId])

// Home/End: when the card itself is focused, jump to the first/last card (↑↓ are handled by keymap's listPrev/listNext and stay within suggestions).
  const onListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if ((e.key !== 'Home' && e.key !== 'End') || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.nativeEvent.isComposing) return
    const card = (e.target as HTMLElement).closest<HTMLElement>('[data-clip-id]')
    if (!card || card !== e.target) return
    const at = clips.findIndex((c) => c.id === card.dataset.clipId)
    const next = rovingStep({ count: clips.length, index: at, key: e.key, columns: 1, orientation: 'vertical' })
    if (next === null) return
    e.preventDefault()
    onActiveChange(clips[next].id)
  }

  const pending = suggestionCount(clips)

  return (
    <div className="hl-tab" id="aside-panel" data-zone="hl" role="region" aria-labelledby="aside-tab-hl">
      <div className="hl-list-head">
        <span className="dim">{t.pending.replace('{n}', String(pending))}</span>
        <div className="hl-view">
          <button
            type="button"
            className={`hl-view-btn${big ? '' : ' on'}`}
            aria-pressed={!big}
            onClick={() => setBig(false)}
          >
            {t.compact}
          </button>
          <button
            type="button"
            className={`hl-view-btn${big ? ' on' : ''}`}
            aria-pressed={big}
            onClick={() => setBig(true)}
          >
            {t.large}
          </button>
        </div>
      </div>
      <p className="hl-hint dim">{t.focusHint}</p>

      <div className="hl-scroll">
        {clips.length === 0 ? (
          <div className="hl-empty">
            <p>{t.empty}</p>
            <button type="button" className="btn-ghost" onClick={onTuneParams}>
              {t.tuneParams}
            </button>
            <p className="dim">{t.emptyHint}</p>
          </div>
        ) : (
          <div className="hl-list" role="list" onKeyDown={onListKeyDown}>
            {clips.map((c) => (
              <HighlightCard
                key={c.id}
                ref={(el) => {
                  if (el) cardRefs.current.set(c.id, el)
                  else cardRefs.current.delete(c.id)
                }}
                clip={c}
                events={events}
                big={big}
                active={c.id === activeId}
                onSelect={(clip) => {
                  onActiveChange(clip.id)
                  onPreview(clip)
                }}
                onPreview={onPreview}
                onAccept={onAccept}
                onSkip={onSkip}
                onRestore={onRestore}
                onRemove={onRemove}
                onFocusCard={(clip) => onActiveChange(clip.id)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="hl-foot">
        <span className="dim mono">
          {t.projectSummary
            .replace('{n}', String(project.items.length))
            .replace('{time}', formatTime(totalDuration(project)))}
        </span>
        <button type="button" className="btn-accent" disabled={pending === 0} onClick={onAddAll}>
          {i18n.studio.track.addAll} <kbd>{i18n.studio.track.addAllKey}</kbd>
        </button>
      </div>
    </div>
  )
}
