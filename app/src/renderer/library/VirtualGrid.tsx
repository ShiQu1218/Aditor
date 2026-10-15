import React, { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { LibraryEntry } from '../../main/library'
import type { DateGroup } from '../lib/groupByDate'
import { CARD, cardGeomStyle, cardRowHeight, computeGrid, gridColumns } from '../lib/gridLayout'
import { i18n } from '../i18n/zh-TW'

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

  const cols = gridColumns(size.width, CARD.min, CARD.gap)
  const cardWidth = size.width > 0 ? (size.width - CARD.gap * (cols - 1)) / cols : CARD.min
  const rowHeight = cardRowHeight(cardWidth)

  const layout = useMemo(
    () =>
      computeGrid({
        width: size.width,
        cardMin: CARD.min,
        gap: CARD.gap,
        rowHeight,
        headerHeight: CARD.headerH,
        groups: groups.map((g) => g.entries.length),
        scrollTop,
        viewHeight: size.height,
        overscanRows: CARD.overscanRows
      }),
    [groups, size.width, size.height, rowHeight, scrollTop]
  )

  return (
    <div
      className="lib-scroll"
      style={cardGeomStyle() as React.CSSProperties}
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
                style={{ top: layout.offsets[row.group], height: CARD.headerH }}
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
          const top = layout.offsets[row.group] + CARD.headerH + Math.floor(row.from / cols) * rowHeight
          return (
            <div
              key={`r-${group.key}-${row.from}`}
              className="lib-row"
              style={{ top, height: rowHeight - CARD.gap, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: CARD.gap }}
            >
              {group.entries.slice(row.from, row.to + 1).map((entry) => renderCard(entry))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
