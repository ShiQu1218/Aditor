import { useRef } from 'react'
import { trackEta } from '../../shared/eta'
import type { LibraryEntry } from '../../main/library'

/**
 * 追蹤 analyzing 項目的分析起始時間，回傳 path → ETA（毫秒或 null）。
 * 每次渲染以 `Date.now()` 更新；分析完成後狀態自動清除。
 */
export function useEtaTracker(entries: readonly LibraryEntry[]): Map<string, number | null> {
  const state = useRef<Map<string, number>>(new Map())
  return trackEta(state.current, entries, Date.now())
}
