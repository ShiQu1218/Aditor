// Virtual library grid layout (pure functions): calculate columns from container width and return only visible rows plus overscan.

/**
 * The single source of card geometry: VirtualGrid calculations and library.css use these values
 * (CSS receives custom properties on the grid container via cardGeomStyle(); tests also lock min to tokens.css --card-min).
 */
export const CARD = {
  /** Minimum card width (tokens --card-min). */
  min: 280,
  gap: 16,
  /** Date-group header height. */
  headerH: 44,
  /** 1px card border. */
  border: 1,
  /** Fixed card text area height; accommodates error cards (name, reason, and a 26px button row). */
  bodyH: 96,
  overscanRows: 2
} as const

/** Total card height including borders: 16:9 thumbnail (based on inner width) plus text area. */
export function cardHeight(cardWidth: number): number {
  return Math.round(((cardWidth - 2 * CARD.border) * 9) / 16) + 2 * CARD.border + CARD.bodyH
}

/** Row height including row gap. */
export function cardRowHeight(cardWidth: number): number {
  return cardHeight(cardWidth) + CARD.gap
}

/** CSS custom properties for the grid container, keeping CSS and TS on the same values. */
export function cardGeomStyle(): Record<string, string> {
  return {
    '--card-min': `${CARD.min}px`,
    '--card-gap': `${CARD.gap}px`,
    '--card-body-h': `${CARD.bodyH}px`
  }
}

export type GridRow =
  | { type: 'header'; group: number }
  | { type: 'row'; group: number; from: number; to: number }

export interface GridParams {
  /** Container logical width in px. */
  width: number
  /** Minimum card width (--card-min, 280). */
  cardMin: number
  /** Card gap in px. */
  gap: number
  /** Card row height, including the gap between rows. */
  rowHeight: number
  /** Date-group header height. */
  headerHeight: number
  /** Number of cards in each group. */
  groups: number[]
  scrollTop: number
  viewHeight: number
  /** Extra rows rendered above and below the visible range. */
  overscanRows: number
}

export interface GridLayoutResult {
  /** Virtual rows to render, by group and row order; excludes rows outside the visible range. */
  rows: GridRow[]
  /** Inclusive range of group indexes intersecting the viewport; [0, -1] when empty. */
  visible: [number, number]
  /** Total height of all rows. */
  totalHeight: number
  /** Y offsets of each group header. */
  offsets: number[]
}

/** Columns = floor((width + gap) / (cardMin + gap)), with at least one column. */
export function gridColumns(width: number, cardMin: number, gap: number): number {
  return Math.max(1, Math.floor((Math.max(0, width) + gap) / (cardMin + gap)))
}

export function computeGrid(p: GridParams): GridLayoutResult {
  const cols = gridColumns(p.width, p.cardMin, p.gap)
  const rowCounts = p.groups.map((n) => Math.ceil(Math.max(0, n) / cols))
  const groupHeights = rowCounts.map((count) => p.headerHeight + count * p.rowHeight)

  const offsets: number[] = []
  let y = 0
  for (const height of groupHeights) {
    offsets.push(y)
    y += height
  }
  const totalHeight = y

  const viewHeight = Math.max(0, p.viewHeight)
  // Clamp scroll position to the content range so a stale scrollTop does not render blank space after filtering shortens the content.
  const scrollTop = Math.min(Math.max(0, p.scrollTop), Math.max(0, totalHeight - viewHeight))
  const top = Math.max(0, scrollTop - p.overscanRows * p.rowHeight)
  const bottom = scrollTop + viewHeight + p.overscanRows * p.rowHeight

  const rows: GridRow[] = []
  const visibleGroups: number[] = []

  p.groups.forEach((n, g) => {
    const groupTop = offsets[g]
    const rowsTop = groupTop + p.headerHeight
    if (groupTop + groupHeights[g] > scrollTop && groupTop < scrollTop + viewHeight) {
      visibleGroups.push(g)
    }
    if (groupTop + p.headerHeight > top && groupTop < bottom) {
      rows.push({ type: 'header', group: g })
    }
    const count = rowCounts[g]
    if (count > 0 && rowsTop + count * p.rowHeight > top && rowsTop < bottom) {
      const first = Math.max(0, Math.floor((top - rowsTop) / p.rowHeight))
      const last = Math.min(count - 1, Math.ceil((bottom - rowsTop) / p.rowHeight) - 1)
      for (let r = first; r <= last; r++) {
        rows.push({ type: 'row', group: g, from: r * cols, to: Math.min(n - 1, (r + 1) * cols - 1) })
      }
    }
  })

  const visible: [number, number] =
    visibleGroups.length > 0 ? [visibleGroups[0], visibleGroups[visibleGroups.length - 1]] : [0, -1]

  return { rows, visible, totalHeight, offsets }
}
