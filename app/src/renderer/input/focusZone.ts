// 焦點區（focus zone）與事件目標分類。純 DOM 輔助，不依賴 React，方便在 node 環境測試。

export type Zone = 'src' | 'hl' | 'ev' | 'proj' | null
export type TargetKind = 'native' | 'text' | 'none'

/** 結構上與 HTMLElement 相容的最小介面（測試可用假物件）。 */
export interface ElementLike {
  tagName: string
  parentElement?: ElementLike | null
  getAttribute(name: string): string | null
}

const ZONES = new Set(['src', 'hl', 'ev', 'proj'])
const NATIVE_ROLES = new Set(['slider', 'checkbox', 'radio'])
const TEXT_INPUT_TYPES = new Set(['text', 'number', 'search', 'email', 'url', 'password', 'tel', ''])

/** button/select/a/role=slider|checkbox|radio/非文字 input → native；文字 input/textarea → text。 */
export function targetKindOf(el: ElementLike | null | undefined): TargetKind {
  if (!el || typeof el.tagName !== 'string') return 'none'
  const tag = el.tagName.toUpperCase()
  if (tag === 'TEXTAREA') return 'text'
  if (tag === 'INPUT') {
    const type = (el.getAttribute('type') ?? '').toLowerCase()
    return TEXT_INPUT_TYPES.has(type) ? 'text' : 'native'
  }
  if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'A') return 'native'
  const role = el.getAttribute('role')
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

// 目前焦點區（由 FocusZoneProvider 的 focusin／mousedown 更新）。模組層級狀態：
// 整個 renderer 只有一個視窗焦點，單一值即可。
let currentZone: Zone = null
export function getCurrentZone(): Zone {
  return currentZone
}
export function setCurrentZone(z: Zone): void {
  currentZone = z
}
