import { useEffect } from 'react'
import { applyInert, setEditorLocked } from './editorLock'

/** 匯出進行中呼叫 `useEditorLock(true)`：專案軌與來源時間軸 inert，且專案資料層拒絕異動。卸載時一定解除。 */
export function useEditorLock(locked: boolean): void {
  useEffect(() => {
    if (!locked) return
    setEditorLocked(true)
    applyInert(document, true)
    return () => {
      setEditorLocked(false)
      applyInert(document, false)
    }
  }, [locked])
}
