import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { resolveKey } from '../input/keymap'
import { ShortcutsDialog } from './ShortcutsDialog'

/** Dialog kind: 'shortcuts' maps to the shortcuts slot in studio/overlays.ts (Escape priority); all others are ordinary dialogs. */
export type OverlayKind = 'shortcuts' | 'dialog'

type OverlayApi = {
  open: (node: React.ReactNode, kind?: OverlayKind) => void
  close: () => void
  /** Shortcuts dialog (shared by `?` and the keyboard button in the icon rail). */
  openShortcuts: () => void
  /** Whether the dialog hosted by OverlayHost is open. */
  isOpen: boolean
  /** Currently open dialog kind (null when closed). */
  kind: OverlayKind | null
  /** Whether the shell's queue popover is open (reported by AppShell; studio shortcuts are paused while open). */
  queueOpen: boolean
}
const OverlayContext = createContext<OverlayApi | null>(null)

export function useOverlay(): OverlayApi {
  const api = useContext(OverlayContext)
  if (!api) throw new Error('useOverlay must be used within OverlayProvider')
  return api
}

/** Optional: return null when no Provider exists (for individually mounted screens). */
export function useOptionalOverlay(): OverlayApi | null {
  return useContext(OverlayContext)
}

/**
 * Dialog container: show only one at a time and close when the backdrop is clicked.
 * Escape uses the keymap's `closeOverlay` in the window capture phase, so it works when focus is outside the dialog and does not reach the underlying screen's Escape handler (such as clearing search).
 */
export function OverlayProvider({ children, queueOpen = false }: { children: React.ReactNode; queueOpen?: boolean }): JSX.Element {
  const [shown, setShown] = useState<{ node: React.ReactNode; kind: OverlayKind } | null>(null)
  const close = useCallback(() => setShown(null), [])
  const open = useCallback((node: React.ReactNode, kind: OverlayKind = 'dialog') => setShown({ node, kind }), [])
  const openShortcuts = useCallback(() => {
    setShown((cur) => cur ?? { node: <ShortcutsDialog onClose={close} />, kind: 'shortcuts' })
  }, [close])

  useEffect(() => {
    if (!shown) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return // An overlay above this one (such as the export drawer) already handled it.
      const cmd = resolveKey(e, { screen: 'studio', zone: null, target: 'none', mode: 'source', overlayOpen: true })
      if (cmd !== 'closeOverlay') return
      e.preventDefault()
      e.stopPropagation()
      close()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [shown, close])

  const value = useMemo<OverlayApi>(
    () => ({ open, close, openShortcuts, isOpen: shown !== null, kind: shown?.kind ?? null, queueOpen }),
    [open, close, openShortcuts, shown, queueOpen]
  )

  return (
    <OverlayContext.Provider value={value}>
      {children}
      {shown && (
        <div
          className="overlay-host"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) close()
          }}
        >
          {shown.node}
        </div>
      )}
    </OverlayContext.Provider>
  )
}
