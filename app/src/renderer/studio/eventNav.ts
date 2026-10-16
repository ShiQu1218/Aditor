/**
 * 上／下一個事件（Ctrl+←／→）的基準時間。
 * 跳到事件時播放頭落在事件前 N 秒（lead-in）；若下一次仍用播放頭時間當基準，
 * 「下一個事件」會再次找到同一個事件而卡住（它還在播放頭之後），「上一個」則會略過 lead-in 區間內的事件。
 * 所以剛由導覽跳到的事件記成錨點：播放頭還停在那個 lead-in 位置時，以事件本身的時間為基準。
 */
export interface NavAnchor {
  /** 事件時間 */
  eventT: number
  /** 導覽時實際 seek 到的時間 */
  seekT: number
}

export function navReference(current: number, anchor: NavAnchor | null, tolerance = 0.25): number {
  return anchor && Math.abs(current - anchor.seekT) <= tolerance ? anchor.eventT : current
}
