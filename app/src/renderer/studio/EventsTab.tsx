import React, { useEffect, useMemo, useRef, useState } from 'react'
import { EngineEvent, EventType } from '../../shared/types'
import { isCounted } from '../../shared/types'
import { VIRTUALIZE_MIN, listWindow } from '../lib/listWindow'
import { i18n } from '../i18n/zh-TW'
import { EventRow } from './EventRow'

/** 列高固定 44 px（含 4 px 列距；spec §3.2.3 虛擬化前提） */
export const EV_ROW_H = 44
const OVERSCAN = 6

export interface EventsTabProps {
  events: EngineEvent[]
  filter: Set<EventType>
  selected: Set<string>
  /** 播放頭附近的事件（列左緣紅線） */
  currentId: string | null
  /** 鍵盤游標列（roving tabindex；↑↓ 移動） */
  cursorId: string | null
  onCursorChange: (id: string | null) => void
  onSeek: (ev: EngineEvent) => void
  onToggleSelect: (id: string) => void
  onSetOverride: (id: string, value: boolean | null) => void
  onDelete: (id: string) => void
  onClearSelection: () => void
  onSupercut: () => void
}

/**
 * 事件分頁（spec §3.2.3）：頂部「計入 N　不計入 M」、列（勾選、圖示、時間、三態、刪除）、
 * 底欄「已選 N 個事件〔清除〕〔建立合輯 Ctrl M〕」；>200 筆時以 listWindow 虛擬化。
 * 篩選沿用播放器下方的類型 chip（同一個 filter 狀態）。
 */
export function EventsTab({
  events,
  filter,
  selected,
  currentId,
  cursorId,
  onCursorChange,
  onSeek,
  onToggleSelect,
  onSetOverride,
  onDelete,
  onClearSelection,
  onSupercut
}: EventsTabProps): JSX.Element {
  const t = i18n.studio.ev
  const scrollRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  const [scrollTop, setScrollTop] = useState(0)
  const [viewHeight, setViewHeight] = useState(0)

  const filtered = useMemo(
    () => events.filter((e) => filter.has(e.type as EventType)),
    [events, filter]
  )

  // 捲動容器高度（虛擬化視窗大小）；ResizeObserver 讓側欄／視窗尺寸變化也能跟上
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = (): void => setViewHeight(el.clientHeight)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 游標變更時移動焦點：只在焦點原本就在清單內、或尚未聚焦（body）時，
  // 避免開啟分頁或點時間軸時搶走播放器／時間軸的焦點。
  useEffect(() => {
    if (!cursorId) return
    const el = rowRefs.current.get(cursorId)
    if (!el) return
    const focused = document.activeElement as HTMLElement | null
    const inEv = typeof focused?.closest === 'function' && focused.closest('[data-zone="ev"]') !== null
    if (inEv || focused === document.body || focused === null) el.focus()
  }, [cursorId])

  const win = listWindow({
    count: filtered.length,
    rowHeight: EV_ROW_H,
    scrollTop,
    viewHeight,
    overscan: OVERSCAN
  })
  const rows = filtered.slice(win.start, win.end)

  const live = events.filter((e) => !e.deleted)
  const counted = live.filter((e) => isCounted(e)).length

  return (
    <div className="ev-tab" data-zone="ev" role="tabpanel" aria-label={t.ariaLabel}>
      <div className="ev-head">
        <span className="ev-sum">
          {t.counted} <b>{counted}</b>
          {'　'}
          {t.uncounted} <b>{live.length - counted}</b>
        </span>
        <span className="dim ev-hint">{t.hint}</span>
      </div>

      <div
        ref={scrollRef}
        className="ev-scroll"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        {filtered.length === 0 ? (
          <p className="dim ev-empty">{events.length === 0 ? t.empty : t.noMatch}</p>
        ) : (
          <div role="list" aria-label={t.ariaLabel} style={{ paddingTop: win.padTop, paddingBottom: win.padBottom }}>
            {rows.map((ev) => (
              <EventRow
                key={ev.id}
                ref={(el) => {
                  if (el) rowRefs.current.set(ev.id, el)
                  else rowRefs.current.delete(ev.id)
                }}
                ev={ev}
                selected={selected.has(ev.id)}
                active={ev.id === cursorId}
                current={ev.id === currentId}
                onSeek={onSeek}
                onToggleSelect={onToggleSelect}
                onSetOverride={onSetOverride}
                onDelete={onDelete}
                onCursor={onCursorChange}
              />
            ))}
          </div>
        )}
      </div>

      <div className="ev-foot">
        <span className="dim">{t.selected.replace('{n}', String(selected.size))}</span>
        <button type="button" className="btn-ghost" disabled={selected.size === 0} onClick={onClearSelection}>
          {t.clear}
        </button>
        <button type="button" className="btn-accent" disabled={selected.size === 0} onClick={onSupercut}>
          {t.supercut} <kbd>{t.supercutKey}</kbd>
        </button>
      </div>
    </div>
  )
}
