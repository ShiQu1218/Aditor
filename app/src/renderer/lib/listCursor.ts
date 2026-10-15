/**
 * 虛擬化事件清單的鍵盤游標輔助（純函式；DOM 端的捲動與焦點留在呼叫端）。
 */

export interface CursorScrollParams {
  index: number
  rowHeight: number
  scrollTop: number
  viewHeight: number
  count: number
}

/**
 * 游標列要完整看見所需的 scrollTop；已完全可見回傳 null。
 * 在視窗上方＝對齊列頂；在下方＝列底對齊視窗底；結果夾在 [0, 內容高-視窗高]。
 */
export function cursorScrollTarget({ index, rowHeight, scrollTop, viewHeight, count }: CursorScrollParams): number | null {
  if (count <= 0 || index < 0 || index >= count) return null
  const max = Math.max(0, count * rowHeight - viewHeight)
  const top = index * rowHeight
  const bottom = top + rowHeight
  let target: number
  if (top < scrollTop) target = top
  else if (bottom > scrollTop + viewHeight) target = bottom - viewHeight
  else return null
  target = Math.min(max, Math.max(0, target))
  return target === scrollTop ? null : target
}

/** roving tabindex：游標列已渲染就用它，否則用第一個已渲染列，確保清單永遠可由 Tab 進入。 */
export function rovingTarget(cursorId: string | null, renderedIds: string[]): string | null {
  if (cursorId && renderedIds.includes(cursorId)) return cursorId
  return renderedIds[0] ?? null
}

/** 播放頭跟隨捲動的限速：從未捲動過（last=0）或距上次已滿 minMs。 */
export function autoScrollDue(now: number, last: number, minMs: number): boolean {
  return last === 0 || now - last >= minMs
}
