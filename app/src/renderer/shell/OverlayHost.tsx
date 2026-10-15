import React, { createContext, useCallback, useContext, useState } from 'react'

type OverlayApi = {
  open: (node: React.ReactNode) => void
  close: () => void
  /** 對話框（OverlayHost 承載）是否開啟 */
  isOpen: boolean
  /** 殼層的佇列浮層是否開啟（由 AppShell 回報；開啟時工作室快捷鍵暫停） */
  queueOpen: boolean
}
const OverlayContext = createContext<OverlayApi | null>(null)

export function useOverlay(): OverlayApi {
  const api = useContext(OverlayContext)
  if (!api) throw new Error('useOverlay 必須在 OverlayProvider 內使用')
  return api
}

/** 對話框容器：同一時間只顯示一個，Esc 或點擊遮罩關閉 */
export function OverlayProvider({ children, queueOpen = false }: { children: React.ReactNode; queueOpen?: boolean }): JSX.Element {
  const [node, setNode] = useState<React.ReactNode>(null)
  const close = useCallback(() => setNode(null), [])
  return (
    <OverlayContext.Provider value={{ open: setNode, close, isOpen: node !== null, queueOpen }}>
      {children}
      {node && (
        <div
          className="overlay-host"
          onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}
          onKeyDown={(e) => { if (e.key === 'Escape') close() }}
        >
          {node}
        </div>
      )}
    </OverlayContext.Provider>
  )
}
