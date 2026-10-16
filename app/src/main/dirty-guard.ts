/**
 * 未儲存變更的關窗保護（I5）：專案自動儲存關閉且有未另存的變更時，關閉視窗前先詢問。
 * renderer 以 `setDirty` 回報狀態；選「儲存」時請 renderer 另存檔案，成功後呼叫 `saved()` 才真正關閉。
 */
export type DirtyChoice = 'save' | 'discard' | 'cancel'

export interface DirtyGuardOptions {
  /** 顯示確認對話框（原生對話框，非 alert） */
  prompt: () => Promise<DirtyChoice>
  /** 請 renderer 執行另存檔案流程 */
  requestSave: () => void
  /** 真正關閉視窗 */
  close: () => void
}

export function createDirtyGuard(opts: DirtyGuardOptions): {
  setDirty: (dirty: boolean) => void
  isDirty: () => boolean
  /** 回傳 true＝已接手（呼叫端不要再往下處理這次 close）。 */
  onClose: (e: { preventDefault(): void }) => boolean
  saved: () => void
  /** 使用者取消另存或另存失敗：回到可再次詢問的狀態，視窗維持開啟。 */
  saveAborted: () => void
} {
  let dirty = false
  let prompting = false
  let waitingSave = false
  return {
    setDirty(v) {
      dirty = v === true
    },
    isDirty: () => dirty,
    onClose(e) {
      if (!dirty) return false
      e.preventDefault()
      if (prompting || waitingSave) return true
      prompting = true
      void opts
        .prompt()
        .catch((): DirtyChoice => 'cancel')
        .then((choice) => {
          prompting = false
          if (choice === 'discard') {
            dirty = false
            opts.close()
          } else if (choice === 'save') {
            waitingSave = true
            opts.requestSave()
          }
        })
      return true
    },
    saveAborted() {
      waitingSave = false
    },
    saved() {
      if (!waitingSave) return
      waitingSave = false
      dirty = false
      opts.close()
    }
  }
}
