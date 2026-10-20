import { useEffect, useRef, type RefObject } from 'react'
import { activateFocusTrap, type FocusTrapOptions } from './focusTrap'

/**
 * Enable the focus trap while the dialog is mounted and restore focus on unmount. `onEscape` reads the latest value through a ref, so callback changes do not re-enable the trap.
 * When `active=false`, the trap is inactive; conditionally rendered components can stay mounted and use `active` for control.
 */
export function useFocusTrap(
  boxRef: RefObject<HTMLElement>,
  opts: {
    active?: boolean
    onEscape?: () => void
    initialFocus?: () => HTMLElement | null | undefined
    returnFocusTo?: () => HTMLElement | null | undefined
  } = {}
): void {
  const { active = true } = opts
  const latest = useRef(opts)
  latest.current = opts
  useEffect(() => {
    const box = boxRef.current
    if (!active || !box) return
    const o: FocusTrapOptions = {
      onEscape: latest.current.onEscape ? () => latest.current.onEscape?.() : undefined,
      initialFocus: latest.current.initialFocus?.() ?? undefined,
      returnFocusTo: latest.current.returnFocusTo ? latest.current.returnFocusTo() : undefined
    }
    return activateFocusTrap(box, o)
  }, [active, boxRef])
}
