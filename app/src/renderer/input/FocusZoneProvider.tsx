import { useEffect, type ReactNode } from 'react'
import { setCurrentZone, zoneAfterEvent } from './focusZone'

/**
 * 以 focusin／focusout／mousedown 與 data-zone 屬性記錄目前焦點區。
 * 點在區域外（無 data-zone）即清為 null；焦點離開到區域外也清除，
 * 避免工作室重新掛載或清單切換後殘留過期的區域。
 */
export function FocusZoneProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const apply = (ev: Parameters<typeof zoneAfterEvent>[0]): void => {
      const next = zoneAfterEvent(ev)
      setCurrentZone(next.zone, next.el)
    }
    const onFocusIn = (e: Event): void =>
      apply({ type: 'focusin', target: e.target as HTMLElement | null, related: (e as FocusEvent).relatedTarget as HTMLElement | null })
    const onFocusOut = (e: Event): void =>
      apply({ type: 'focusout', target: e.target as HTMLElement | null, related: (e as FocusEvent).relatedTarget as HTMLElement | null })
    const onMouseDown = (e: Event): void =>
      apply({ type: 'mousedown', target: e.target as HTMLElement | null, related: null })
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    document.addEventListener('mousedown', onMouseDown, true)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
      document.removeEventListener('mousedown', onMouseDown, true)
      setCurrentZone(null)
    }
  }, [])
  return <>{children}</>
}
