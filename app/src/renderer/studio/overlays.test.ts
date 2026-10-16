import { describe, expect, test } from 'vitest'
import { isAnyOverlayOpen, topOverlay, type OverlayState } from './overlays'

const none: OverlayState = {
  addEvent: false,
  autoClip: false,
  newProject: false,
  hostDialog: false,
  exportDrawer: false,
  queuePopover: false,
  shortcuts: false
}

describe('isAnyOverlayOpen', () => {
  test('false when nothing is open', () => {
    expect(isAnyOverlayOpen(none)).toBe(false)
  })
  test.each(Object.keys(none) as (keyof OverlayState)[])('true when only %s is open', (k) => {
    expect(isAnyOverlayOpen({ ...none, [k]: true })).toBe(true)
  })
})

describe('topOverlay', () => {
  test('null when none open', () => expect(topOverlay(none)).toBeNull())
  test('modal dialogs rank above popovers; add-event above host dialog', () => {
    expect(topOverlay({ ...none, autoClip: true, addEvent: true })).toBe('addEvent')
    expect(topOverlay({ ...none, hostDialog: true, queuePopover: true })).toBe('hostDialog')
    expect(topOverlay({ ...none, queuePopover: true })).toBe('queuePopover')
    expect(topOverlay({ ...none, newProject: true, autoClip: true })).toBe('newProject')
  })
})
