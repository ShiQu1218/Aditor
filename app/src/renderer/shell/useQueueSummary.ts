import { useEffect, useMemo, useState } from 'react'
import type { LibraryEntry } from '../../main/library'

export interface QueueSummary {
  /** 分析中＋等待中的項目（分析中在前，等待依加入時間排序） */
  active: LibraryEntry[]
  analyzing: LibraryEntry | null
  /** 目前分析進度 0–1（無分析中項目時為 0） */
  progress: number
}

/**
 * 全域分析佇列摘要（訂閱 `library:updated`）：供圖示欄環形進度、佇列條與浮層共用。
 */
export function useQueueSummary(): QueueSummary {
  const [entries, setEntries] = useState<LibraryEntry[]>([])

  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      const data = await window.api?.library?.getEntries?.()
      if (alive && Array.isArray(data)) {
        setEntries(data)
      }
    }
    void load()
    const unsubscribe = window.api?.library?.onUpdated?.(() => {
      void load()
    })
    return () => {
      alive = false
      unsubscribe?.()
    }
  }, [])

  return useMemo(() => {
    const active = entries
      .filter((e) => e.status === 'analyzing' || e.status === 'pending')
      .sort((a, b) => {
        if ((a.status === 'analyzing') !== (b.status === 'analyzing')) {
          return a.status === 'analyzing' ? -1 : 1
        }
        return a.addedAt - b.addedAt
      })
    const analyzing = active.find((e) => e.status === 'analyzing') ?? null
    return { active, analyzing, progress: analyzing?.progress ?? 0 }
  }, [entries])
}
