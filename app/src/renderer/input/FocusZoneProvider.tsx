import { useEffect, type ReactNode } from 'react'
import { setCurrentZone, zoneOf } from './focusZone'

/**
 * 以 focusin／mousedown 與 data-zone 屬性記錄目前焦點區。
 * 點在區域外（無 data-zone）即清為 null。
 */
export function FocusZoneProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const update = (e: Event) => setCurrentZone(zoneOf(e.target as HTMLElement | null))
    document.addEventListener('focusin', update)
    document.addEventListener('mousedown', update, true)
    return () => {
      document.removeEventListener('focusin', update)
      document.removeEventListener('mousedown', update, true)
      setCurrentZone(null)
    }
  }, [])
  return <>{children}</>
}
