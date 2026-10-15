import React from 'react'
import { EngineEvent, EventType, isCounted } from '../../shared/types'
import { formatTime } from '../../shared/time'

interface EventListProps {
  events: EngineEvent[]
  selected: Set<string>
  filter: Set<EventType>
  onSelectEvent: (e: EngineEvent) => void
  onToggleSelect: (id: string) => void
  onToggleOverride: (id: string, current: boolean | null) => void
  onDeleteEvent: (id: string) => void
}

const TYPE_LABELS: Record<string, string> = {
  knock: '擊倒',
  assist_knock: '助攻擊倒',
  assist_elim: '助攻消滅',
  elim: '已消滅',
  squad_wipe: '小隊抹殺'
}

const TYPE_COLORS: Record<string, string> = {
  knock: '#e13b30',
  assist_knock: '#38bdf8',
  assist_elim: '#60a5fa',
  elim: '#f97316',
  squad_wipe: '#a855f7'
}

export function EventList({
  events,
  selected,
  filter,
  onSelectEvent,
  onToggleSelect,
  onToggleOverride,
  onDeleteEvent
}: EventListProps): JSX.Element {
  const filtered = events.filter((e) => filter.has(e.type as EventType))

  const cycleOverride = (e: EngineEvent) => {
    // Cycle: null -> true -> false -> null
    if (e.counted_override === null || e.counted_override === undefined) {
      onToggleOverride(e.id, true)
    } else if (e.counted_override === true) {
      onToggleOverride(e.id, false)
    } else {
      onToggleOverride(e.id, null)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto', maxHeight: '100%' }}>
      {filtered.length === 0 ? (
        <div style={{ color: '#64748b', fontSize: 13, textAlign: 'center', padding: 20 }}>
          無符合篩選條件的事件
        </div>
      ) : (
        filtered.map((ev) => {
          const counted = isCounted(ev)
          const isDeleted = Boolean(ev.deleted)
          const color = TYPE_COLORS[ev.type] || '#94a3b8'
          const isSel = selected.has(ev.id)

          return (
            <div
              key={ev.id}
              onClick={() => onSelectEvent(ev)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 10px',
                backgroundColor: isSel ? '#2e3240' : '#22242e',
                borderRadius: 6,
                cursor: 'pointer',
                opacity: isDeleted ? 0.4 : 1,
                border: isSel ? '1px solid #38bdf8' : '1px solid #303340',
                transition: 'background-color 0.1s'
              }}
            >
              {/* Checkbox for batch/supercut selection */}
              <input
                type="checkbox"
                checked={isSel}
                onChange={(e) => {
                  e.stopPropagation()
                  onToggleSelect(ev.id)
                }}
                style={{ cursor: 'pointer' }}
              />

              {/* Timestamp */}
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: '#f8fafc',
                  fontFamily: 'monospace',
                  textDecoration: isDeleted ? 'line-through' : 'none'
                }}
              >
                {formatTime(ev.t)}
              </span>

              {/* Badge */}
              <span
                style={{
                  fontSize: 11,
                  padding: '2px 6px',
                  borderRadius: 4,
                  backgroundColor: color,
                  color: '#fff',
                  fontWeight: 600,
                  whiteSpace: 'nowrap'
                }}
              >
                {TYPE_LABELS[ev.type] || ev.type}
              </span>

              {/* Damage line indicator */}
              {ev.damage_line && (
                <span style={{ fontSize: 11, color: '#f59e0b' }} title="包含傷害數值">
                  ⚔️
                </span>
              )}

              {/* Score / Source */}
              <span style={{ fontSize: 11, color: '#64748b', marginLeft: 'auto' }}>
                {ev.source === 'manual' ? '手動' : `${Math.round(ev.score * 100)}%`}
              </span>

              {/* Counted override toggle button */}
              {!isDeleted && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    cycleOverride(ev)
                  }}
                  title={
                    ev.counted_override === true
                      ? '已強制計入 (點擊切換為不計入)'
                      : ev.counted_override === false
                      ? '已強制不計入 (點擊恢復自動)'
                      : '自動判定計入 (點擊強制計入)'
                  }
                  style={{
                    fontSize: 10,
                    padding: '2px 6px',
                    borderRadius: 3,
                    border: 'none',
                    cursor: 'pointer',
                    backgroundColor:
                      ev.counted_override === true
                        ? '#22c55e'
                        : ev.counted_override === false
                        ? '#64748b'
                        : '#374151',
                    color: '#fff'
                  }}
                >
                  {ev.counted_override === true
                    ? '計入'
                    : ev.counted_override === false
                    ? '不計'
                    : counted
                    ? '計(自)'
                    : '否(自)'}
                </button>
              )}

              {/* Delete button */}
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onDeleteEvent(ev.id)
                }}
                title={isDeleted ? '已刪除' : '刪除事件'}
                disabled={isDeleted}
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: isDeleted ? '#475569' : '#ef4444',
                  cursor: isDeleted ? 'default' : 'pointer',
                  fontSize: 14,
                  padding: '0 4px'
                }}
              >
                ✕
              </button>
            </div>
          )
        })
      )}
    </div>
  )
}
