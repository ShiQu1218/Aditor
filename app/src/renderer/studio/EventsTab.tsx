import React, { useEffect, useMemo, useRef, useState } from 'react'
import { EngineEvent, EventType, isCounted } from '../../shared/types'
import { listWindow } from '../lib/listWindow'
import { autoScrollDue, cursorScrollTarget, rovingTarget } from '../lib/listCursor'
import { i18n } from '../i18n/zh-TW'
import { EventRow } from './EventRow'

/** 列高固定 44 px（含 4 px 列距；spec §3.2.3 虛擬化前提） */
export const EV_ROW_H = 44
const OVERSCAN = 6
/** 播放頭跟隨捲動的最短間隔（毫秒） */
const FOLLOW_MIN_MS = 600

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

  const win = listWindow({
    count: filtered.length,
    rowHeight: EV_ROW_H,
    scrollTop,
    viewHeight,
    overscan: OVERSCAN
  })
  const rows = filtered.slice(win.start, win.end)
  // roving tabindex：游標列不在渲染範圍時由第一個已渲染列頂替，清單永遠可由 Tab 進入
  const rovingId = rovingTarget(
    cursorId,
    rows.map((e) => e.id)
  )

  /** 捲動容器到指定 scrollTop（同步更新視窗狀態，讓下一次渲染就包含目標列）。 */
  const scrollListTo = (top: number): void => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = top
    setScrollTop(top)
  }

  /** 把第 index 個（篩選後）事件捲進視窗；已完全可見則不動。 */
  const revealIndex = (index: number): void => {
    const el = scrollRef.current
    if (!el) return
    const target = cursorScrollTarget({
      index,
      rowHeight: EV_ROW_H,
      scrollTop: el.scrollTop,
      viewHeight: el.clientHeight,
      count: filtered.length
    })
    if (target !== null) scrollListTo(target)
  }

  // 游標變更：先把游標列捲進視窗（可能尚未渲染），再於渲染後移動焦點
  const pendingFocus = useRef<string | null>(null)
  const prevCursor = useRef<string | null>(cursorId) // 掛載時已有的游標不觸發捲動／對焦
  useEffect(() => {
    if (!cursorId || cursorId === prevCursor.current) return
    prevCursor.current = cursorId
    const index = filtered.findIndex((e) => e.id === cursorId)
    if (index < 0) return
    pendingFocus.current = cursorId
    revealIndex(index)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursorId])

  // 渲染後：游標列已在 DOM 才移動焦點。只在焦點原本就在清單內、或在 body（列捲出被卸載）時，
  // 避免開啟分頁或點時間軸時搶走播放器／時間軸的焦點。
  useEffect(() => {
    const id = pendingFocus.current
    if (!id) return
    const el = rowRefs.current.get(id)
    if (!el) return
    pendingFocus.current = null
    const focused = document.activeElement as HTMLElement | null
    const inEv = typeof focused?.closest === 'function' && focused.closest('[data-zone="ev"]') !== null
    if (inEv || focused === document.body || focused === null) el.focus({ preventScroll: true })
  })

  // 播放頭事件：分頁開啟時捲進視窗一次；播放中移動則限速跟隨（使用者正操作清單時不搶捲動）
  const lastFollow = useRef(0)
  useEffect(() => {
    if (!currentId) return
    const el = scrollRef.current
    if (!el) return
    const now = Date.now()
    if (lastFollow.current !== 0) {
      if (el.contains(document.activeElement)) return
      if (!autoScrollDue(now, lastFollow.current, FOLLOW_MIN_MS)) return
    }
    const index = filtered.findIndex((e) => e.id === currentId)
    if (index < 0) return
    lastFollow.current = now
    revealIndex(index)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId])

  // 使用者滾輪捲動使焦點列被卸載時，把焦點留在清單容器（避免落到 body 而離開 ev 區）
  const handleScroll = (e: React.UIEvent<HTMLDivElement>): void => {
    const el = e.currentTarget
    const top = el.scrollTop
    setScrollTop(top)
    const focused = document.activeElement as HTMLElement | null
    if (!focused || focused === el || !el.contains(focused)) return
    const idx = cursorId ? filtered.findIndex((x) => x.id === cursorId) : -1
    if (idx < 0) return
    const w = listWindow({
      count: filtered.length,
      rowHeight: EV_ROW_H,
      scrollTop: top,
      viewHeight: el.clientHeight,
      overscan: OVERSCAN
    })
    if (idx < w.start || idx >= w.end) el.focus({ preventScroll: true })
  }

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
        tabIndex={-1}
        onScroll={handleScroll}
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
                active={ev.id === rovingId}
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
