// Focus zones and event-target classification. Pure DOM helpers with no React dependency, so they can be tested in Node.

export type Zone = 'src' | 'hl' | 'proj' | null
export type TargetKind = 'native' | 'text' | 'none'

/** Minimal HTMLElement-compatible interface; tests may use mock objects. */
export interface ElementLike {
  tagName: string
  parentElement?: ElementLike | null
  /** Browser-computed editability (including inherited state); optional on test mocks. */
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
  // If isContentEditable is unavailable, walk ancestors to find contenteditable.
  for (let cur: ElementLike | null = el; cur; cur = cur.parentElement ?? null) {
    const v = cur.getAttribute('contenteditable')
    if (v === null) continue
    const t = v.toLowerCase()
    return t === '' || t === 'true' || t === 'plaintext-only'
  }
  return false
}

/**
 * button/select/a/role=slider|tab|menuitem|switch…/non-text input → native;
 * text input/textarea/contenteditable/role=textbox… → text; everything else (including role=option/listbox/row/gridcell/listitem) → none.
 *
 * List rows (hl/proj with role=option/listitem) must not use <button>,
 * or Enter/Delete zone keys will be allowed by native-control rules (resolveKey returns null).
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

/** Find the nearest data-zone by walking up from an element. */
export function zoneOf(el: ElementLike | null | undefined): Zone {
  for (let cur = el ?? null; cur; cur = cur.parentElement ?? null) {
    const z = cur.getAttribute('data-zone')
    if (z) return ZONES.has(z) ? (z as Zone) : null
  }
  return null
}

// Current focus zone, updated by FocusZoneProvider's focusin/focusout/mousedown handlers. Module-level state:
// the renderer has one window focus at a time, so a single value is sufficient.
// Keep the last element as well; once removed (isConnected === false), its zone is stale.
// This prevents `zoneOf(el) ?? getCurrentZone()` from returning an old zone after a DOM rerender.
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
   * Pointer latch: a mousedown just occurred inside a zone. Clicking a non-focusable element blurs
   * the previously focused element (focusout with relatedTarget null); that focusout must not clear the clicked zone.
   * Protect only the immediately following focusout; any focusin or outside mousedown releases the latch.
   */
  latched: boolean
}

export const initialZoneState: ZoneState = { zone: null, el: null, latched: false }

export type ZoneEvent = {
  type: 'focusin' | 'focusout' | 'mousedown'
  target: ElementLike | null
  related: ElementLike | null
}

/** Compute the next focus-zone state from a focus event (pure function shared by FocusZoneProvider and sequence tests). */
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
      // Focus moved to another zone: record the new zone.
      const next = zoneOf(ev.related)
      if (next !== null) return { zone: next, el: ev.related, latched: false }
      // Blur caused by clicking a non-focusable element inside a zone: keep the zone and consume the latch.
      if (state.latched) return { ...state, latched: false }
      // Focus left all zones: clear the current zone.
      return initialZoneState
    }
  }
}
