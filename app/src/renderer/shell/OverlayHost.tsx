import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { resolveKey } from '../input/keymap'
import { ShortcutsDialog } from './ShortcutsDialog'

/** 對話框種類：'shortcuts' 對應 studio/overlays.ts 的 shortcuts 槽位（Esc 優先序）；其餘為一般對話框。 */
export type OverlayKind = 'shortcuts' | 'dialog'

type OverlayApi = {
  open: (node: React.ReactNode, kind?: OverlayKind) => void
  close: () => void
  /** 快捷鍵說明（`?` 與圖示欄鍵盤按鈕共用） */
  openShortcuts: () => void
  /** 對話框（OverlayHost 承載）是否開啟 */
  isOpen: boolean
  /** 目前開啟的對話框種類（未開啟＝null） */
  kind: OverlayKind | null
  /** 殼層的佇列浮層是否開啟（由 AppShell 回報；開啟時工作室快捷鍵暫停） */
  queueOpen: boolean
}
const OverlayContext = createContext<OverlayApi | null>(null)

export function useOverlay(): OverlayApi {
  const api = useContext(OverlayContext)
  if (!api) throw new Error('useOverlay 必須在 OverlayProvider 內使用')
  return api
}

/** 可選：沒有 Provider（單獨掛載的畫面）時回傳 null。 */
export function useOptionalOverlay(): OverlayApi | null {
  return useContext(OverlayContext)
}

/**
 * 對話框容器：同一時間只顯示一個，點擊遮罩關閉。
 * Esc 走 keymap 的 `closeOverlay`，綁在 window 捕捉階段——焦點不在對話框內也有效，且不再傳給底下畫面的 Esc 處理（例如清除搜尋）。
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
      if (e.defaultPrevented) return // 更上層（例如匯出抽屜）已處理
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
