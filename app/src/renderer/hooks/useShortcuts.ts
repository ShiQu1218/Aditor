import { useEffect } from 'react'

export interface ShortcutHandlers {
  onPlayPause?: () => void
  onCycleSpeed?: () => void
  onPrevEvent?: () => void
  onNextEvent?: () => void
  onQuickClip?: () => void
  onAddEvent?: () => void
  onSendToProject?: () => void
  onZoomIn?: () => void
  onZoomOut?: () => void
  onZoomReset?: () => void
}

export function useShortcuts(handlers: ShortcutHandlers, enabled = true): void {
  useEffect(() => {
    if (!enabled) return

    const onKeyDown = (e: KeyboardEvent) => {
      // Don't intercept when user is typing in an input
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) {
        return
      }

      const isCtrl = e.ctrlKey || e.metaKey

      if (e.code === 'Space') {
        e.preventDefault()
        handlers.onPlayPause?.()
      } else if (!isCtrl && e.key.toLowerCase() === 's') {
        e.preventDefault()
        handlers.onCycleSpeed?.()
      } else if (!isCtrl && e.key.toLowerCase() === 'm') {
        e.preventDefault()
        handlers.onAddEvent?.()
      } else if (isCtrl && e.key.toLowerCase() === 'q') {
        e.preventDefault()
        handlers.onQuickClip?.()
      } else if (isCtrl && e.key.toLowerCase() === 'e') {
        e.preventDefault()
        handlers.onSendToProject?.()
      } else if (isCtrl && e.key === 'ArrowLeft') {
        e.preventDefault()
        handlers.onPrevEvent?.()
      } else if (isCtrl && e.key === 'ArrowRight') {
        e.preventDefault()
        handlers.onNextEvent?.()
      } else if (isCtrl && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        handlers.onZoomIn?.()
      } else if (isCtrl && (e.key === '-' || e.key === '_')) {
        e.preventDefault()
        handlers.onZoomOut?.()
      } else if (isCtrl && e.key === '0') {
        e.preventDefault()
        handlers.onZoomReset?.()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handlers, enabled])
}
