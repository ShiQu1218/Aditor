import React from 'react'
import { EventType } from '../../shared/types'
import { i18n } from '../i18n'
import { Scissors, Sparkles } from '../components/icons'
import { EventFilterChips } from './EventFilterChips'

interface TransportBarProps {
  counts: Record<EventType, number>
  /** Event types shown as filter chips for this video's game. */
  chipTypes?: EventType[]
  filter: Set<EventType>
  onAddEvent: () => void
  onQuick: () => void
  bladeMode: boolean
  onAutoClip: () => void
  autoClipOpen: boolean
  onToggleFilter: (t: EventType) => void
}

/** Editing tools, event filters, and add event. */
export function TransportBar({
  counts,
  chipTypes,
  filter,
  onAddEvent,
  onQuick,
  bladeMode,
  onAutoClip,
  autoClipOpen,
  onToggleFilter
}: TransportBarProps): JSX.Element {
  const t = i18n.studio.transport
  return (
    <div className="transport">
      <button
        type="button"
        className="btn-ghost"
        aria-pressed={bladeMode}
        title={i18n.timeline.bladeHint}
        onClick={onQuick}
      >
        <Scissors className="ic sm" /> {i18n.studio.quickClip} <kbd>{i18n.studio.quickClipKey}</kbd>
      </button>
      <button
        type="button"
        className="btn-ghost"
        data-autoclip="toggle"
        aria-haspopup="dialog"
        aria-expanded={autoClipOpen}
        onClick={onAutoClip}
      >
        <Sparkles className="ic sm" /> {i18n.studio.autoClip}
      </button>
      <EventFilterChips counts={counts} filter={filter} onToggle={onToggleFilter} types={chipTypes} />
      <button type="button" className="btn-ghost" onClick={onAddEvent}>
        {t.addEvent} <kbd>M</kbd>
      </button>
    </div>
  )
}
