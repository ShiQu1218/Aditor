import { useEffect, useRef, type RefObject } from 'react'
import { activateFocusTrap, type FocusTrapOptions } from './focusTrap'

/**
 * 對話框掛載期間啟用焦點陷阱（卸載時還原焦點）。`onEscape` 以 ref 讀最新值，不會因 callback 變動重新啟用。
 * `active=false` 時不作用（條件式渲染的元件可永遠掛著並以 active 控制）。
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
