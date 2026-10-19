import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { LibraryEntry } from '../../main/library'
import type { DateGroup } from '../lib/groupByDate'
import { CARD, cardGeomStyle, cardRowHeight, computeGrid, gridColumns, type GridRow } from '../lib/gridLayout'
import { revealScrollTarget } from '../lib/listCursor'
import { gridStep, type GridPos } from '../a11y/roving'
import { i18n } from '../i18n'

interface VirtualGridProps {
  groups: DateGroup[]
  /** active＝目前的 roving tabindex 游標卡片（整個網格只有它在 Tab 順序內） */
  renderCard: (entry: LibraryEntry, active: boolean) => React.ReactNode
}

const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'])

/**
 * 虛擬化日期分組網格：只渲染可視列＋上下各 2 列 overscan。
 * 欄寬依容器寬度計算（卡片高度固定），捲動時不重新測量卡片。
 *
 * 鍵盤（roving tabindex）：整個網格只有一個 Tab 停靠點（游標卡片）；
 * 焦點在卡片主按鈕時 ←→↑↓／Home／End 移動游標（欄數取自 computeGrid 的實際欄數，跨日期分組延伸）。
 * 游標卡片被虛擬化捲出時：移動時先把它捲進視窗再對焦；有焦點時其所在列永遠保持渲染，滾輪捲動不會讓焦點掉到 body。
 */
export function VirtualGrid({ groups, renderCard }: VirtualGridProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [scrollTop, setScrollTop] = useState(0)
  /** roving 游標（卡片路徑）；null＝尚未選擇，預設第一張 */
  const [cursorPath, setCursorPath] = useState<string | null>(null)
  /** 焦點目前在哪張卡片內（保持其所在列渲染）；焦點離開網格即清除 */
  const [focusedPath, setFocusedPath] = useState<string | null>(null)
  const pendingFocus = useRef<string | null>(null)

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

  /** path → 分組內位置；游標失效（被篩掉）時退回第一張 */
  const positions = useMemo(() => {
    const m = new Map<string, GridPos>()
    groups.forEach((g, gi) => g.entries.forEach((e, i) => m.set(e.path, { group: gi, index: i })))
    return m
  }, [groups])
  const firstPath = groups.find((g) => g.entries.length > 0)?.entries[0].path ?? null
  const activePath = cursorPath !== null && positions.has(cursorPath) ? cursorPath : firstPath

  /** 把 (group,index) 那張卡片捲進視窗所需的 scrollTop（已可見＝null）。 */
  const revealTarget = (pos: GridPos, viewTop: number, viewHeight: number): number | null => {
    const rowIdx = Math.floor(pos.index / cols)
    // 組內第一列連同日期表頭一起看見
    const top = rowIdx === 0 ? layout.offsets[pos.group] : layout.offsets[pos.group] + CARD.headerH + rowIdx * rowHeight
    const height = (rowIdx === 0 ? CARD.headerH : 0) + rowHeight - CARD.gap
    return revealScrollTarget({ top, height, scrollTop: viewTop, viewHeight, contentHeight: layout.totalHeight })
  }

  const moveTo = (pos: GridPos): void => {
    const path = groups[pos.group].entries[pos.index].path
    setCursorPath(path)
    pendingFocus.current = path
    const el = scrollRef.current
    if (!el) return
    const target = revealTarget(pos, el.scrollTop, el.clientHeight)
    if (target !== null) {
      el.scrollTop = target
      setScrollTop(target)
    }
  }

  // 渲染後：游標卡片已在 DOM 才移動焦點（捲動使它剛被渲染時也在這裡完成）
  useEffect(() => {
    const path = pendingFocus.current
    if (path === null) return
    const root = scrollRef.current
    if (!root) return
    const card = Array.from(root.querySelectorAll<HTMLElement>('[data-vcard-path]')).find((c) => c.dataset.vcardPath === path)
    const btn = card?.querySelector<HTMLElement>('.vcard-open')
    if (!btn) return
    pendingFocus.current = null
    btn.focus({ preventScroll: true })
  })

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!NAV_KEYS.has(e.key) || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.nativeEvent.isComposing) return
    const target = e.target as HTMLElement
    // 只有卡片主按鈕參與網格導覽；收藏／⋯／重試等次要按鈕的方向鍵保留原生語意
    if (!target.classList.contains('vcard-open')) return
    const path = target.closest<HTMLElement>('.vcard')?.dataset.vcardPath
    const from = path ? positions.get(path) : undefined
    if (!from) return
    e.preventDefault() // 不讓方向鍵捲動容器
    const next = gridStep({ groups: groups.map((g) => g.entries.length), group: from.group, index: from.index, key: e.key, columns: cols })
    if (next) moveTo(next)
  }

  const onFocus = (e: React.FocusEvent<HTMLDivElement>): void => {
    const path = (e.target as HTMLElement).closest<HTMLElement>('.vcard')?.dataset.vcardPath
    if (!path) return
    setCursorPath(path)
    setFocusedPath(path)
  }

  const onBlur = (e: React.FocusEvent<HTMLDivElement>): void => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusedPath(null)
  }

  // 有焦點的卡片所在列即使捲出視窗也保持渲染（絕不把焦點卸載掉）
  let rendered: GridRow[] = layout.rows
  const fpos = focusedPath !== null ? positions.get(focusedPath) : undefined
  if (fpos) {
    const from = Math.floor(fpos.index / cols) * cols
    if (!rendered.some((r) => r.type === 'row' && r.group === fpos.group && r.from === from)) {
      const n = groups[fpos.group].entries.length
      rendered = [...rendered, { type: 'row', group: fpos.group, from, to: Math.min(n - 1, from + cols - 1) }]
    }
  }

  return (
    <div
      className="lib-scroll"
      style={cardGeomStyle() as React.CSSProperties}
      ref={scrollRef}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onBlur={onBlur}
      data-testid="library-grid"
    >
      <div className="lib-inner" style={{ height: layout.totalHeight }}>
        {rendered.map((row) => {
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
              {group.entries.slice(row.from, row.to + 1).map((entry) => renderCard(entry, entry.path === activePath))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
