import { useEffect, type ReactNode } from 'react'
import { initialZoneState, reduceZone, setCurrentZone, type ZoneEvent, type ZoneState } from './focusZone'

/**
 * Track the current focus zone using focusin/focusout/mousedown and the data-zone attribute.
 * Clicking outside a zone (no data-zone) clears it to null; focus leaving all zones also clears it,
 * preventing a stale zone after the studio remounts or the list changes.
 */
export function FocusZoneProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    let state: ZoneState = initialZoneState
    const apply = (ev: ZoneEvent): void => {
      state = reduceZone(state, ev)
      setCurrentZone(state.zone, state.el)
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
      state = initialZoneState
      setCurrentZone(null)
    }
  }, [])
  return <>{children}</>
}
