import React, { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { LibraryEntry } from '../../main/library'
import type { DateGroup } from '../lib/groupByDate'
import { computeGrid, gridColumns } from '../lib/gridLayout'
import { i18n } from '../i18n/zh-TW'

/** 與 spec §3.1／tokens 對齊的網格常數 */
const CARD_MIN = 280
const GAP = 16
const HEADER_H = 44
const BODY_H = 72
const OVERSCAN_ROWS = 2

interface VirtualGridProps {
  groups: DateGroup[]
  renderCard: (entry: LibraryEntry) => React.ReactNode
}

/**
 * 虛擬化日期分組網格：只渲染可視列＋上下各 2 列 overscan。
 * 欄寬依容器寬度計算（卡片高度固定），捲動時不重新測量卡片。
 */
export function VirtualGrid({ groups, renderCard }: VirtualGridProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [scrollTop, setScrollTop] = useState(0)

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = (): void => setSize({ width: el.clientWidth, height: el.clientHeight })
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const cols = gridColumns(size.width, CARD_MIN, GAP)
  const cardWidth = size.width > 0 ? (size.width - GAP * (cols - 1)) / cols : CARD_MIN
  const rowHeight = Math.round((cardWidth * 9) / 16 + BODY_H) + GAP

  const layout = useMemo(
    () =>
      computeGrid({
        width: size.width,
        cardMin: CARD_MIN,
        gap: GAP,
        rowHeight,
        headerHeight: HEADER_H,
        groups: groups.map((g) => g.entries.length),
        scrollTop,
        viewHeight: size.height,
        overscanRows: OVERSCAN_ROWS
      }),
    [groups, size.width, size.height, rowHeight, scrollTop]
  )

  return (
    <div
      className="lib-scroll"
      ref={scrollRef}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      data-testid="library-grid"
    >
      <div className="lib-inner" style={{ height: layout.totalHeight }}>
        {layout.rows.map((row) => {
          if (row.type === 'header') {
            const group = groups[row.group]
            return (
              <div
                key={`h-${group.key}`}
                className="lib-group-head"
                style={{ top: layout.offsets[row.group], height: HEADER_H }}
                role="presentation"
              >
                <span className="lib-group-label">{group.label}</span>
                <span className="lib-group-count">
                  {i18n.library.videoCount.replace('{n}', String(group.entries.length))}
                </span>
              </div>
            )
          }
          const group = groups[row.group]
          const top = layout.offsets[row.group] + HEADER_H + Math.floor(row.from / cols) * rowHeight
          return (
            <div
              key={`r-${group.key}-${row.from}`}
              className="lib-row"
              style={{ top, height: rowHeight - GAP, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: GAP }}
            >
              {group.entries.slice(row.from, row.to + 1).map((entry) => renderCard(entry))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
