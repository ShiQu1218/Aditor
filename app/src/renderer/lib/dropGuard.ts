/**
 * 全域拖放保護（I2）：在 document 層對 dragover／drop 呼叫 preventDefault，
 * 避免把檔案拖進視窗時 Chromium 導航到該檔案。各畫面自己的 drop 處理器（例如影片庫匯入）不受影響。
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
