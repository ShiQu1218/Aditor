// 對話框／浮層的焦點陷阱：純索引函式＋可重用的 DOM 啟用器（所有對話框共用同一份實作）。

/** Tab／Shift+Tab 後應聚焦的索引；無可聚焦元素回 -1。 */
export function nextTrapIndex(count: number, current: number, shift: boolean): number {
  if (count <= 0) return -1
  if (current < 0) return shift ? count - 1 : 0
  return shift ? (current - 1 + count) % count : (current + 1) % count
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** 容器內目前可用 Tab 聚焦的元素（略過 disabled、hidden、inert 子樹；單選群組只算已選取的那一個，與瀏覽器的 Tab 行為一致）。 */
export function focusablesIn(root: HTMLElement): HTMLElement[] {
  const all = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hidden && el.closest('[inert], [hidden]') === null
  )
  const radios = all.filter((el): el is HTMLInputElement => el instanceof HTMLInputElement && el.type === 'radio' && el.name !== '')
  const groupsWithChecked = new Set(radios.filter((r) => r.checked).map((r) => r.name))
  const seenUnchecked = new Set<string>()
  return all.filter((el) => {
    if (!(el instanceof HTMLInputElement) || el.type !== 'radio' || el.name === '') return true
    if (groupsWithChecked.has(el.name)) return el.checked
    if (seenUnchecked.has(el.name)) return false
    seenUnchecked.add(el.name)
    return true
  })
}

export interface FocusTrapOptions {
  /** Esc：呼叫後事件不再傳給全域 keymap（避免同一個 Esc 被處理兩次） */
  onEscape?: () => void
  /** 開啟時聚焦的元素；省略＝第一個可聚焦元素，沒有則聚焦容器本身 */
  initialFocus?: HTMLElement | null
  /** 關閉時還原焦點的元素；省略＝開啟當下的焦點元素（觸發元素） */
  returnFocusTo?: HTMLElement | null
}

/**
 * 啟用焦點陷阱並回傳解除函式：
 * - 開啟時記住目前焦點（觸發元素）並把焦點移進 `box`；
 * - Tab／Shift+Tab 只在 `box` 內循環（焦點跑到框外也會被拉回）；
 * - Esc 交給 `onEscape`（IME 組字中忽略）；
 * - 解除時把焦點還給觸發元素（若它仍在文件中，且焦點沒有被使用者移到別處）。
 * 監聽綁在 window 的捕捉階段，焦點不在框內時也有效。
 */
export function activateFocusTrap(box: HTMLElement, opts: FocusTrapOptions = {}): () => void {
  const opener = (document.activeElement as HTMLElement | null) ?? null
  if (!box.hasAttribute('tabindex')) box.setAttribute('tabindex', '-1')
  const first = opts.initialFocus ?? focusablesIn(box)[0] ?? box
  first.focus()

  const onKey = (e: KeyboardEvent): void => {
    if (e.isComposing || e.keyCode === 229) return
    if (e.key === 'Escape') {
      if (!opts.onEscape) return
      e.preventDefault()
      e.stopPropagation()
      opts.onEscape()
    } else if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const list = focusablesIn(box)
      e.preventDefault()
      if (list.length === 0) {
        box.focus()
        return
      }
      const i = nextTrapIndex(list.length, list.indexOf(document.activeElement as HTMLElement), e.shiftKey)
      list[i]?.focus()
    }
  }
  window.addEventListener('keydown', onKey, true)

  return () => {
    window.removeEventListener('keydown', onKey, true)
    const back = opts.returnFocusTo === undefined ? opener : opts.returnFocusTo
    // 只在焦點還在框內、或已掉到 body（框被移除）時還原；使用者已點到別處就不搶走焦點
    const active = document.activeElement
    const lost = !active || active === document.body || box.contains(active)
    if (lost && back && back.isConnected && typeof back.focus === 'function') back.focus()
  }
}
