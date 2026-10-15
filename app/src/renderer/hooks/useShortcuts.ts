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

/**
 * 綁定 window.keydown，以 resolveKey 解析後呼叫對應 handler 並 preventDefault。
 * 未提供 handler 的指令不攔截（保留瀏覽器／原生行為）。
 */
export function useKeymap(handlers: KeymapHandlers, opts: KeymapOptions = {}): void {
  const { enabled = true, screen = 'studio', mode = 'source', overlayOpen = false } = opts
  // 以 ref 讀最新值，避免每次 render 重綁監聽
  const latest = useRef({ handlers, screen, mode, overlayOpen })
  latest.current = { handlers, screen, mode, overlayOpen }

  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const cur = latest.current
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
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled])
}

// ---- 舊匯出別名（Task 10 刪除舊 Viewer 時一併移除） ----
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
  useKeymap(
    {
      play: handlers.onPlayPause,
      speed: handlers.onCycleSpeed,
      prevEvent: handlers.onPrevEvent,
      nextEvent: handlers.onNextEvent,
      quickOrSplit: handlers.onQuickClip,
      addEvent: handlers.onAddEvent,
      addAllToProject: handlers.onSendToProject,
      zoomIn: handlers.onZoomIn,
      zoomOut: handlers.onZoomOut,
      zoomReset: handlers.onZoomReset
    },
    { enabled }
  )
}
