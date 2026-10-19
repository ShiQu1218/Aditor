// 錄影中觀看的純函式：套用 main 推播、找出新事件、時間軸換算。不依賴 React／DOM。
import type { LiveEvent, LiveMatch, LiveState, LiveUpdate } from '../../shared/recording'
import { isCounted } from '../../shared/types'

/** 套用 `recording:live` 推播（不同錄影工作的推播忽略）；回傳新物件。 */
export function applyLiveUpdate(state: LiveState, update: LiveUpdate): LiveState {
  if (update.sessionId !== state.sessionId) return state
  let next = state
  if (update.segments) next = { ...next, segments: update.segments }
  if (update.segment && !state.segments.some((s) => s.seq === update.segment!.seq)) {
    next = { ...next, segments: [...next.segments, update.segment] }
  }
  if (update.events) next = { ...next, events: update.events }
  if (update.spectating) next = { ...next, spectating: update.spectating }
  if (update.match) {
    const { index, start, end } = update.match
    const matches: LiveMatch[] = next.matches.slice(0, index - 1)
    // 補齊漏收的前幾局（不應發生；保持索引一致）
    while (matches.length < index - 1) matches.push({ start, end: start })
    matches.push({ start, end })
    next = { ...next, matches }
  }
  return next
}

/** 新出現且計入的事件（供 aria-live 宣告）。 */
export function newCountedEvents(prev: LiveEvent[], next: LiveEvent[]): LiveEvent[] {
  const seen = new Set(prev.map((e) => e.id))
  return next.filter((e) => !seen.has(e.id) && isCounted(e))
}

export function liveEnd(state: LiveState): number {
  return state.segments.reduce((end, s) => Math.max(end, s.pts + s.dur), 0)
}

/** 時間 → 時間軸百分比（0–100）。 */
export function pct(t: number, end: number): number {
  if (!(end > 0)) return 0
  return Math.min(100, Math.max(0, (t / end) * 100))
}

/** 以 `{key}` 代入字串樣板。 */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) => (key in vars ? String(vars[key]) : m))
}

/** 事件清單點擊：跳到事件前 3 秒。 */
export const EVENT_LEAD_SEC = 3
export const SEEK_STEP_SEC = 5
