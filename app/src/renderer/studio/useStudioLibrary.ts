import { useCallback, useEffect, useState } from 'react'
import type { LibraryEntry } from '../../main/library'

/** Subscribe to the library; ignore stale load results and responses after unmount. */
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
        if (!Array.isArray(data)) throw new Error('Invalid library data')
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
