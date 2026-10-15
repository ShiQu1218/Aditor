// 影片庫虛擬網格版面（純函式）：依容器寬度算欄數，只回傳可視列＋上下 overscan。

export type GridRow =
  | { type: 'header'; group: number }
  | { type: 'row'; group: number; from: number; to: number }

export interface GridParams {
  /** 容器邏輯寬度（px） */
  width: number
  /** 卡片最小寬度（--card-min，280） */
  cardMin: number
  /** 卡片間距（px） */
  gap: number
  /** 一列卡片的高度（含列與列之間的間距） */
  rowHeight: number
  /** 日期分組表頭高度 */
  headerHeight: number
  /** 各組卡片數 */
  groups: number[]
  scrollTop: number
  viewHeight: number
  /** 可視範圍上下額外渲染的列數 */
  overscanRows: number
}

export interface GridLayoutResult {
  /** 要渲染的虛擬列（依分組與列序；不含可視範圍外者） */
  rows: GridRow[]
  /** 與視窗相交的分組索引範圍（含端點；無則 [0, -1]） */
  visible: [number, number]
  /** 全部列的總高度 */
  totalHeight: number
  /** 各分組表頭的 y 位移 */
  offsets: number[]
}

/** 欄數 = floor((width+gap)/(cardMin+gap))，至少 1 欄。 */
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
  // 捲動位置夾在內容範圍內（過濾使內容變短時，舊 scrollTop 不至於渲染空白）
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
