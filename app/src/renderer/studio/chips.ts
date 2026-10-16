import { isCounted, type EngineEvent, type EventType } from '../../shared/types'

/**
 * 事件類型 chip 的固定順序（spec §5.2）。引擎只輸出擊倒與助攻（助攻擊倒／助攻消滅），
 * elim／squad_wipe 不再有篩選 chip；舊專案／舊快取裡既有的這兩類事件仍顯示（預設篩選集合包含它們）、型別保持相容。
 */
export const CHIP_TYPES: EventType[] = ['knock', 'assist_knock', 'assist_elim']

/** 各類型未刪除事件數（chip 上的計數）。 */
export function chipCounts(events: EngineEvent[]): Record<EventType, number> {
  const out = { knock: 0, assist_knock: 0, assist_elim: 0, elim: 0, squad_wipe: 0 } as Record<EventType, number>
  for (const e of events) {
    if (e.deleted) continue
    if (e.type in out) out[e.type as EventType] += 1
  }
  return out
}

/** 切換單一類型（回傳新集合，不變動原集合）。 */
export function toggleFilter(filter: Set<EventType>, t: EventType): Set<EventType> {
  const next = new Set(filter)
  if (next.has(t)) next.delete(t)
  else next.add(t)
  return next
}

/** 「近 90 秒計入」：視窗 [t-90, t] 內、未刪除且計入的事件數（資訊用，spec §3.2.1）。 */
export function nearCount(events: EngineEvent[], t: number, windowSec = 90): number {
  const from = t - windowSec
  let n = 0
  for (const e of events) {
    if (e.t < from || e.t > t) continue
    if (e.deleted) continue
    if (isCounted(e)) n += 1
  }
  return n
}
