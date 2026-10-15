import type { EngineEvent } from '../../shared/types'

/**
 * 事件分頁操作的純規劃函式（spec §3.2.3、§3.6）：derive 回應合併、刪除目標、
 * 批次刪除復原與框選結果。
 */

/**
 * 把引擎 derive 的回應合併進「目前」事件清單：只套用推導欄位 counted／counted_reason（依 id）。
 * 其他欄位（deleted、counted_override、手動新增的事件…）一律保留目前的值，
 * 所以 await 期間的刪除或 override 編輯不會被舊快照蓋掉。
 */
export function mergeDerived(current: EngineEvent[], derived: EngineEvent[]): EngineEvent[] {
  const byId = new Map(derived.map((e) => [e.id, e]))
  return current.map((e) => {
    const d = byId.get(e.id)
    if (!d) return e
    return { ...e, counted: d.counted, counted_reason: d.counted_reason }
  })
}

/** 序號閘門：只接受最近一次發出的請求的回應（亂序到達的舊回應丟棄）。 */
export function createLatestGate(): { next: () => number; isLatest: (ticket: number) => boolean } {
  let n = 0
  return {
    next: () => ++n,
    isLatest: (ticket) => ticket === n
  }
}

/** Delete（事件分頁）要刪的事件：有勾選＝勾選的；沒有勾選＝游標列（存在且未刪除）；否則空。 */
export function planDeleteEvents(selected: Set<string>, cursorId: string | null, events: EngineEvent[]): string[] {
  if (selected.size > 0) return [...selected]
  if (!cursorId) return []
  const target = events.find((e) => e.id === cursorId)
  return target && !target.deleted ? [cursorId] : []
}

export interface BatchDeletePlan {
  ids: string[]
  /** 〔復原〕時要還原的選取（刪除前的選取集合） */
  undoSelection: string[]
}

export function planBatchDelete(ids: string[], selectionBefore: Set<string>): BatchDeletePlan {
  return { ids, undoSelection: [...selectionBefore] }
}

/** 框選結果：0 個事件＝什麼都不做（不 Toast、不清除既有選取）。 */
export function planBoxSelect(ids: string[], additive: boolean): { mode: 'add' | 'replace' } | null {
  if (ids.length === 0) return null
  return { mode: additive ? 'add' : 'replace' }
}
