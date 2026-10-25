import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { LibraryEntry } from '../../main/library'
import type { DateGroup } from '../lib/groupByDate'
import { CARD, cardGeomStyle, cardRowHeight, computeGrid, gridColumns, type GridRow } from '../lib/gridLayout'
import { revealScrollTarget } from '../lib/listCursor'
import { gridStep, type GridPos } from '../a11y/roving'
import { i18n } from '../i18n'
import { CopyCheck } from '../components/icons'
import { isAllSelected } from './selection'

interface VirtualGridProps {
  groups: DateGroup[]
  /** active is the current roving-tabindex card (the only card in the grid's Tab order). */
  renderCard: (entry: LibraryEntry, active: boolean) => React.ReactNode
  /** Multi-select mode: every date header shows its group selection button. */
  selectionMode?: boolean
  /** Currently selected paths (used by the per-group select/deselect button). */
  selected?: ReadonlySet<string>
  /** Toggle every entry of the date group at groupIndex. */
  onToggleGroup?: (groupIndex: number) => void
}

const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'])

  /**
   * Virtualized date-group grid: render only visible rows plus two overscan rows above and below.
   * Column width is calculated from the container width (card height is fixed); cards are not remeasured while scrolling.
   *
   * Keyboard (roving tabindex): the grid has one Tab stop (the cursor card).
   * When the main card button is focused, ←→↑↓/Home/End moves the cursor (using the actual column count from computeGrid across date groups).
   * If virtualization has scrolled the cursor card out, scroll it into view before focusing it; keep the focused row rendered so wheel scrolling does not drop focus to body.
   */
export function VirtualGrid({ groups, renderCard, selected, onToggleGroup }: VirtualGridProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [scrollTop, setScrollTop] = useState(0)
  /** Roving cursor (card path); null means none selected, defaulting to the first card. */
  const [cursorPath, setCursorPath] = useState<string | null>(null)
  /** Card currently containing focus (keeps its row rendered); cleared when focus leaves the grid. */
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

  /** Path to group position; if the cursor becomes invalid (filtered out), fall back to the first card. */
  const positions = useMemo(() => {
    const m = new Map<string, GridPos>()
    groups.forEach((g, gi) => g.entries.forEach((e, i) => m.set(e.path, { group: gi, index: i })))
    return m
  }, [groups])
  const firstPath = groups.find((g) => g.entries.length > 0)?.entries[0].path ?? null
  const activePath = cursorPath !== null && positions.has(cursorPath) ? cursorPath : firstPath

  /** scrollTop needed to bring the card at (group,index) into view (null if already visible). */
  const revealTarget = (pos: GridPos, viewTop: number, viewHeight: number): number | null => {
    const rowIdx = Math.floor(pos.index / cols)
  // Show the group's first row together with its date header.
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

  // After rendering, move focus only once the cursor card is in the DOM (also handles cards rendered by scrolling).
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
    // Only the card's main button participates in grid navigation; arrow keys on secondary controls (favorite/⋯/retry) keep their native meaning.
    if (!target.classList.contains('vcard-open')) return
    const path = target.closest<HTMLElement>('.vcard')?.dataset.vcardPath
    const from = path ? positions.get(path) : undefined
    if (!from) return
    e.preventDefault() // Prevent arrow keys from scrolling the container.
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

  // Keep the focused card's row rendered even after it scrolls out of view; never unmount the focused element.
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
            const groupPaths = group.entries.map((entry) => entry.path)
            const allSelected = selected !== undefined && isAllSelected(selected, groupPaths)
            const groupLabel = allSelected ? i18n.library.selection.deselectGroup : i18n.library.selection.selectGroup
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
                {onToggleGroup && (
                  <button
                    type="button"
                    className="lib-group-select"
                    title={groupLabel}
                    aria-label={groupLabel}
                    aria-pressed={allSelected}
                    onClick={() => onToggleGroup(row.group)}
                  >
                    <CopyCheck className="ic sm" />
                  </button>
                )}
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
