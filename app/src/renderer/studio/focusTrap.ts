/** 對話框焦點陷阱（純函式）：回傳 Tab／Shift+Tab 後應聚焦的索引；無可聚焦元素回 -1。 */
export function nextTrapIndex(count: number, current: number, shift: boolean): number {
  if (count <= 0) return -1
  if (current < 0) return shift ? count - 1 : 0
  return shift ? (current - 1 + count) % count : (current + 1) % count
}
