/** 工作室目前開啟中的浮層／對話框（純資料，供 keymap 的 overlayOpen 與 Esc 關閉順序使用）。 */
export interface OverlayState {
  addEvent: boolean
  autoClip: boolean
  newProject: boolean
  /** OverlayHost 承載的對話框（匯出、快捷鍵說明…） */
  hostDialog: boolean
  /** 匯出抽屜（只覆蓋側欄；開啟時 keymap 只剩 Esc） */
  exportDrawer: boolean
  queuePopover: boolean
  shortcuts: boolean
}

export type OverlayKey = keyof OverlayState

/** 由上而下＝最上層優先（Esc 先關最上層）。 */
const PRIORITY: OverlayKey[] = ['addEvent', 'newProject', 'shortcuts', 'hostDialog', 'exportDrawer', 'autoClip', 'queuePopover']

export function isAnyOverlayOpen(s: OverlayState): boolean {
  return PRIORITY.some((k) => s[k])
}

export function topOverlay(s: OverlayState): OverlayKey | null {
  return PRIORITY.find((k) => s[k]) ?? null
}
