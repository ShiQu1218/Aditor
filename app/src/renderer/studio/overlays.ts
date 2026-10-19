/** Currently open studio overlays/dialogs (data only, used by keymap's overlayOpen state and Esc close order). */
export interface OverlayState {
  addEvent: boolean
  autoClip: boolean
  newProject: boolean
/** Dialogs hosted by OverlayHost (export, shortcut help, etc.). */
  hostDialog: boolean
/** Export drawer (covers only the sidebar; while open, keymap handles only Esc). */
  exportDrawer: boolean
  queuePopover: boolean
  shortcuts: boolean
}

export type OverlayKey = keyof OverlayState

/** Top to bottom is highest to lowest priority (Esc closes the topmost first). */
const PRIORITY: OverlayKey[] = ['addEvent', 'newProject', 'shortcuts', 'hostDialog', 'exportDrawer', 'autoClip', 'queuePopover']

export function isAnyOverlayOpen(s: OverlayState): boolean {
  return PRIORITY.some((k) => s[k])
}

export function topOverlay(s: OverlayState): OverlayKey | null {
  return PRIORITY.find((k) => s[k]) ?? null
}
