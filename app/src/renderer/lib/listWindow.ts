/**
 * 事件清單虛擬化視窗計算（spec §3.2.3）：
 * 事件 >200 筆才啟用（列高固定 44 px），少於等於門檻直接回傳完整範圍。
 * 純函式，方便測試；DOM 端的捲動量測與焦點留在呼叫端。
 */
export const VIRTUALIZE_MIN = 200

export interface ListWindowParams {
  count: number
  rowHeight: number
  scrollTop: number
  viewHeight: number
  overscan: number
}

export interface ListWindow {
  /** 渲染起點（含） */
  start: number
  /** 渲染終點（不含） */
  end: number
  /** 上方略過列的高度補償（px） */
  padTop: number
  /** 下方略過列的高度補償（px） */
  padBottom: number
}

export function listWindow({ count, rowHeight, scrollTop, viewHeight, overscan }: ListWindowParams): ListWindow {
  if (count <= VIRTUALIZE_MIN) {
    return { start: 0, end: count, padTop: 0, padBottom: 0 }
  }
  const first = Math.min(
    Math.max(0, Math.floor(Math.max(0, scrollTop) / rowHeight)),
    Math.max(0, count - 1)
  )
  const visible = Math.ceil(viewHeight / rowHeight)
  const start = Math.max(0, first - overscan)
  const end = Math.min(count, first + visible + overscan)
  return { start, end, padTop: start * rowHeight, padBottom: (count - end) * rowHeight }
}
