import { useEffect } from 'react'
import { applyInert, setEditorLocked } from './editorLock'

/** Call `useEditorLock(true)` during export to make the project track and source timeline inert and reject project data changes. Always unlock on unmount. */
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
