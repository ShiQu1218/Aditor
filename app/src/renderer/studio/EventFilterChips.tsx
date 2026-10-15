import React from 'react'
import { EventType } from '../../shared/types'
import { i18n } from '../i18n/zh-TW'
import { CHIP_TYPES } from './chips'

interface EventFilterChipsProps {
  counts: Record<EventType, number>
  filter: Set<EventType>
  onToggle: (t: EventType) => void
}

/** 事件類型篩選 chip（帶計數）：圖示色塊＋數量，按下切換該類型。 */
export function EventFilterChips({ counts, filter, onToggle }: EventFilterChipsProps): JSX.Element {
  const types = i18n.timeline.types
  return (
    <div className="chips" role="group" aria-label={i18n.studio.transport.filterLabel}>
      {CHIP_TYPES.map((type) => {
        const active = filter.has(type)
        const label = (types as Record<string, string>)[type] ?? type
        return (
          <button
            key={type}
            type="button"
            className={`chip chip-${type}${active ? ' on' : ''}`}
            aria-pressed={active}
            aria-label={`${label} ${counts[type]}`}
            onClick={() => onToggle(type)}
          >
            <i className="chip-dot" aria-hidden="true" />
            <span className="chip-n mono">{counts[type]}</span>
          </button>
        )
      })}
    </div>
  )
}
