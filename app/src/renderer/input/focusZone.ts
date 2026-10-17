// 焦點區（focus zone）與事件目標分類。純 DOM 輔助，不依賴 React，方便在 node 環境測試。

export type Zone = 'src' | 'hl' | 'proj' | null
export type TargetKind = 'native' | 'text' | 'none'

/** 結構上與 HTMLElement 相容的最小介面（測試可用假物件）。 */
export interface ElementLike {
  tagName: string
  parentElement?: ElementLike | null
  /** 瀏覽器計算後（含祖先繼承）的可編輯狀態；測試假物件可省略 */
  isContentEditable?: boolean
  getAttribute(name: string): string | null
}

const ZONES = new Set(['src', 'hl', 'proj'])
const TEXT_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton'])
const NATIVE_ROLES = new Set([
  'slider',
  'checkbox',
  'radio',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'switch',
  'button',
  'link'
])
const TEXT_INPUT_TYPES = new Set(['text', 'number', 'search', 'email', 'url', 'password', 'tel', ''])

function isEditable(el: ElementLike): boolean {
  if (typeof el.isContentEditable === 'boolean') return el.isContentEditable
  // 無 isContentEditable 時手動沿祖先找 contenteditable
  for (let cur: ElementLike | null = el; cur; cur = cur.parentElement ?? null) {
    const v = cur.getAttribute('contenteditable')
    if (v === null) continue
    const t = v.toLowerCase()
    return t === '' || t === 'true' || t === 'plaintext-only'
  }
  return false
}

/**
 * button/select/a/role=slider|tab|menuitem|switch…/非文字 input → native；
 * 文字 input/textarea/contenteditable/role=textbox… → text；其餘（含 role=option/listbox/row/gridcell/listitem）→ none。
 *
 * 清單列（hl/proj 的 role=option/listitem）不可使用 <button>，
 * 否則 Enter/Delete 區域鍵會被原生控制項規則放行（resolveKey 回傳 null）。
 */
export function targetKindOf(el: ElementLike | null | undefined): TargetKind {
  if (!el || typeof el.tagName !== 'string') return 'none'
  const tag = el.tagName.toUpperCase()
  if (tag === 'TEXTAREA' || isEditable(el)) return 'text'
  const role = el.getAttribute('role')
  if (role && TEXT_ROLES.has(role)) return 'text'
  if (tag === 'INPUT') {
    const type = (el.getAttribute('type') ?? '').toLowerCase()
    return TEXT_INPUT_TYPES.has(type) ? 'text' : 'native'
  }
  if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'A') return 'native'
  if (role && NATIVE_ROLES.has(role)) return 'native'
  return 'none'
}

/** 由元素往上找最近的 data-zone。 */
export function zoneOf(el: ElementLike | null | undefined): Zone {
  for (let cur = el ?? null; cur; cur = cur.parentElement ?? null) {
    const z = cur.getAttribute('data-zone')
    if (z) return ZONES.has(z) ? (z as Zone) : null
  }
  return null
}

// 目前焦點區（由 FocusZoneProvider 的 focusin／focusout／mousedown 更新）。模組層級狀態：
// 整個 renderer 只有一個視窗焦點，單一值即可。
// 一併記住最後一次所在的元素；元素被移除（isConnected === false）後即視為過期，
// 避免 `zoneOf(el) ?? getCurrentZone()` 在 DOM 重繪後回傳殘留的舊區域。
let currentZone: Zone = null
let currentEl: ElementLike | null = null

export function setCurrentZone(z: Zone, el: ElementLike | null = null): void {
  currentZone = z
  currentEl = z ? el : null
}

export function getCurrentZone(): Zone {
  const connected = (currentEl as { isConnected?: boolean } | null)?.isConnected
  if (connected === false) return null
  return currentZone
}

export interface ZoneState {
  zone: Zone
  el: ElementLike | null
  /**
   * 指標鎖存：剛在區域內 mousedown。點在非可聚焦元素上時，瀏覽器會讓原本聚焦的元素 blur
   * （focusout，relatedTarget 為 null）；這次 focusout 不得把剛點到的區域清掉。
   * 只保護緊接著的那一次 focusout，任何 focusin／區域外 mousedown 都會解除。
   */
  latched: boolean
}

export const initialZoneState: ZoneState = { zone: null, el: null, latched: false }

export type ZoneEvent = {
  type: 'focusin' | 'focusout' | 'mousedown'
  target: ElementLike | null
  related: ElementLike | null
}

/** 由焦點事件計算下一個焦點區狀態（純函式，供 FocusZoneProvider 與序列測試共用）。 */
export function reduceZone(state: ZoneState, ev: ZoneEvent): ZoneState {
  switch (ev.type) {
    case 'mousedown': {
      const zone = zoneOf(ev.target)
      return zone ? { zone, el: ev.target, latched: true } : initialZoneState
    }
    case 'focusin': {
      const zone = zoneOf(ev.target)
      return zone ? { zone, el: ev.target, latched: false } : initialZoneState
    }
    case 'focusout': {
      // 焦點移到其他區域：記錄新區域
      const next = zoneOf(ev.related)
      if (next !== null) return { zone: next, el: ev.related, latched: false }
      // 指標剛點在區域內（非可聚焦）造成的 blur：維持區域，鎖存用掉
      if (state.latched) return { ...state, latched: false }
      // 離開到區域外 → 清除
      return initialZoneState
    }
  }
}
