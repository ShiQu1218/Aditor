import React from 'react'
import { EventType } from '../../shared/types'

interface EventTypeFilterProps {
  filter: Set<EventType>
  onChange: (filter: Set<EventType>) => void
}

const TYPES: Array<{ key: EventType; label: string; color: string }> = [
  { key: 'knock', label: '擊倒', color: '#e13b30' },
  { key: 'assist_knock', label: '助攻擊倒', color: '#38bdf8' },
  { key: 'assist_elim', label: '助攻消滅', color: '#60a5fa' },
  { key: 'elim', label: '已消滅', color: '#f97316' },
  { key: 'squad_wipe', label: '小隊抹殺', color: '#a855f7' }
]

export function EventTypeFilter({ filter, onChange }: EventTypeFilterProps): JSX.Element {
  const toggle = (t: EventType) => {
    const next = new Set(filter)
    if (next.has(t)) {
      next.delete(t)
    } else {
      next.add(t)
    }
    onChange(next)
  }

  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {TYPES.map(({ key, label, color }) => {
        const active = filter.has(key)
        return (
          <button
            key={key}
            onClick={() => toggle(key)}
            style={{
              padding: '4px 10px',
              fontSize: 12,
              borderRadius: 4,
              cursor: 'pointer',
              border: `1px solid ${color}`,
              backgroundColor: active ? color : 'transparent',
              color: active ? '#ffffff' : color,
              fontWeight: active ? 600 : 400,
              transition: 'all 0.15s'
            }}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}
