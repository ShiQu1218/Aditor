/**
 * Global drag-and-drop guard (I2): call preventDefault for dragover/drop at the document level
 * to prevent Chromium from navigating to a file dropped into the window. Screen-specific drop handlers (such as library import) are unaffected.
 */
export function installGlobalDropGuard(doc: Document = document): () => void {
  const block = (e: Event): void => {
    e.preventDefault()
  }
  doc.addEventListener('dragover', block)
  doc.addEventListener('drop', block)
  return () => {
    doc.removeEventListener('dragover', block)
    doc.removeEventListener('drop', block)
  }
}
