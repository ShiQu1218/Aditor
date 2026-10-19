import { useCallback, useEffect, useState } from 'react'
import type { LibraryEntry } from '../../main/library'

/** 訂閱影片庫；較舊的讀取結果與卸載後的回應不再套用。 */
export function useStudioLibrary(): { entries: LibraryEntry[] | null; failed: boolean; retry: () => void } {
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [revision, setRevision] = useState(0)
  const retry = useCallback(() => setRevision((value) => value + 1), [])
  useEffect(() => {
    let alive = true
    let sequence = 0
    const load = async (): Promise<void> => {
      const request = ++sequence
      try {
        const data: unknown = await window.api?.library?.getEntries?.()
        if (!Array.isArray(data)) throw new Error('影片庫資料無效')
        if (alive && request === sequence) {
          setEntries(data)
          setFailed(false)
        }
      } catch {
        if (alive && request === sequence) setFailed(true)
      }
    }
    setFailed(false)
    const off = window.api?.library?.onUpdated?.(() => { void load() })
    void load()
    return () => { alive = false; off?.() }
  }, [revision])
  return { entries, failed, retry }
}
