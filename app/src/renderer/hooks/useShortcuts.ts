import { useEffect, useRef } from 'react'
import { getCurrentZone, targetKindOf, zoneOf } from '../input/focusZone'
import { resolveKey, type Command, type KeyCtx } from '../input/keymap'

export type KeymapHandlers = Partial<Record<Command, () => void>>

export interface KeymapOptions {
  enabled?: boolean
  screen?: KeyCtx['screen']
  mode?: KeyCtx['mode']
  overlayOpen?: boolean
}

export interface KeymapState extends Required<Omit<KeymapOptions, 'enabled'>> {
  handlers: KeymapHandlers
}

/** Create a keydown handler independent of React for isolated testing. */
export function createKeyDownHandler(getState: () => KeymapState): (e: KeyboardEvent) => void {
  return (e) => {
    if (e.isComposing || e.keyCode === 229) return
    if (e.defaultPrevented) return
    const el = e.target as HTMLElement | null
    const cur = getState()
    if (isStudioSpace(e, cur)) e.preventDefault()
    const cmd = resolveKey(e, {
      screen: cur.screen,
      mode: cur.mode,
      overlayOpen: cur.overlayOpen,
      zone: zoneOf(el) ?? getCurrentZone(),
      target: targetKindOf(el)
    })
    if (!cmd) return
    const fn = cur.handlers[cmd]
    if (!fn) return
    e.preventDefault()
    fn()
  }
}

/** In the studio, Space must not trigger native button clicks; leave text fields and IME composition to the browser. */
function isStudioSpace(e: KeyboardEvent, state: KeymapState): boolean {
  return state.screen === 'studio' && (e.code === 'Space' || e.key === ' ') &&
    !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing && e.keyCode !== 229 &&
    targetKindOf(e.target as HTMLElement | null) !== 'text'
}

/** Attach to target and return a cleanup function. */
export function attachKeymap(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  getState: () => KeymapState
): () => void {
  const onKeyDown = createKeyDownHandler(getState)
  const onKeyUp = (e: KeyboardEvent): void => {
    if (isStudioSpace(e, getState())) e.preventDefault()
  }
  target.addEventListener('keydown', onKeyDown as EventListener)
  target.addEventListener('keyup', onKeyUp as EventListener)
  return () => {
    target.removeEventListener('keydown', onKeyDown as EventListener)
    target.removeEventListener('keyup', onKeyUp as EventListener)
  }
}

/**
 * Bind window.keydown, resolve the key with resolveKey, call its handler, and preventDefault.
 * Do not intercept commands without a handler; preserve browser/native behavior.
 */
export function useKeymap(handlers: KeymapHandlers, opts: KeymapOptions = {}): void {
  const { enabled = true, screen = 'studio', mode = 'source', overlayOpen = false } = opts
  // Read the latest value through a ref to avoid rebinding on every render.
  const latest = useRef<KeymapState>({ handlers, screen, mode, overlayOpen })
  latest.current = { handlers, screen, mode, overlayOpen }

  useEffect(() => {
    if (!enabled) return
    return attachKeymap(window, () => latest.current)
  }, [enabled])
}
