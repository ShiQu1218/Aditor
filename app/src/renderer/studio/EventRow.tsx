import React, { forwardRef } from 'react'
import { EngineEvent, isCounted } from '../../shared/types'
import { formatTime } from '../../shared/time'
import { shapeFor } from '../timeline/eventShapes'
import { X } from '../components/icons'
import { i18n } from '../i18n/zh-TW'
import { eventAriaLabel, eventReason } from './reasons'
import { TriState } from './TriState'

/** 事件圖示（形狀＋顏色＋字形三重編碼，spec §5.2）：不計入＝空心＋65% 不透明。 */
function EventGlyph({ type, counted }: { type: string; counted: boolean }): JSX.Element {
  const spec = shapeFor(type)
  return (
    <span className={`evt${counted ? '' : ' off'}`} data-type={type} aria-hidden="true">
      <svg className="evt-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
        <path d={spec.glyph} />
      </svg>
    </span>
  )
}

export interface EventRowProps {
  ev: EngineEvent
  selected: boolean
  /** 鍵盤游標列（roving tabindex） */
  active: boolean
  /** 播放頭附近的事件（列左緣紅線） */
  current: boolean
  onSeek: (ev: EngineEvent) => void
  onToggleSelect: (id: string) => void
  onSetOverride: (id: string, value: boolean | null) => void
  onDelete: (id: string) => void
  onCursor: (id: string) => void
}

/**
 * 事件列（spec §3.2.3）：勾選框、事件圖示、時間、類型＋原因小字、三態分段、刪除。
 * 列本身不可用 `<button>`（keymap 區域鍵規則）——div＋role=listitem＋roving tabindex。
 */
export const EventRow = forwardRef<HTMLDivElement, EventRowProps>(function EventRow(
  { ev, selected, active, current, onSeek, onToggleSelect, onSetOverride, onDelete, onCursor },
  ref
) {
  const t = i18n.studio.ev
  const counted = isCounted(ev)
  const typeLabel = (i18n.timeline.types as Record<string, string>)[ev.type] ?? ev.type
  const sub = [
    eventReason(ev),
    ev.damage_line ? t.damageLine : '',
    ev.source === 'manual' ? '' : `${Math.round(ev.score * 100)}%`
  ]
    .filter(Boolean)
    .join(' · ')
  const classes = [
    'ev-row',
    selected ? 'sel' : '',
    ev.deleted ? 'deleted' : '',
    current ? 'cur' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      ref={ref}
      className={classes}
      role="listitem"
      tabIndex={active ? 0 : -1}
      aria-label={eventAriaLabel(ev)}
      data-ev-id={ev.id}
      onClick={(e) => {
        const el = e.target as HTMLElement
        if (el.closest('button') || el.closest('input')) return
        onSeek(ev)
      }}
      onFocus={() => onCursor(ev.id)}
    >
      <input
        type="checkbox"
        checked={selected}
        disabled={Boolean(ev.deleted)}
        tabIndex={active ? 0 : -1}
        aria-label={t.checkbox}
        onChange={() => onToggleSelect(ev.id)}
      />
      <EventGlyph type={ev.type} counted={counted} />
      <span className="ev-time mono">{formatTime(ev.t)}</span>
      <span className="ev-lbl">
        {typeLabel}
        <small>{sub}</small>
      </span>
      <TriState value={ev.counted_override ?? null} onChange={(v) => onSetOverride(ev.id, v)} tabIndex={active ? 0 : -1} />
      <button
        type="button"
        className="icon-btn ev-del"
        tabIndex={active ? 0 : -1}
        aria-label={t.delete}
        disabled={Boolean(ev.deleted)}
        onClick={(e) => {
          e.stopPropagation()
          onDelete(ev.id)
        }}
      >
        <X className="ic sm" />
      </button>
    </div>
  )
})
