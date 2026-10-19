// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { SettingsScreen } from './SettingsScreen'
import { createFakeApi, installFakeApi } from '../../../test/fakeApi'
import { Providers } from '../../../test/harness'
import { cleanupMounted, flush, focusEl, installDomShims, mount, press } from '../../../test/dom'

let restore: () => void
beforeEach(async () => {
  installDomShims()
  restore = installFakeApi(createFakeApi())
  mount(
    <Providers active="settings">
      <SettingsScreen />
    </Providers>
  )
  await flush(30)
})
afterEach(() => {
  cleanupMounted()
  restore()
})

const tabs = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]'))

describe('settings category tabs (Task 16, verified in jsdom)', () => {
  test('tablist with one tab stop (the selected tab); the panel is labelled by the selected tab', () => {
    expect(tabs().length).toBe(6)
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1, -1, -1, -1, -1])
    expect(tabs()[0].getAttribute('aria-selected')).toBe('true')
    const panel = document.getElementById('set-panel')!
    expect(panel.getAttribute('role')).toBe('tabpanel')
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs()[0].id)
  })

  test('ArrowDown/ArrowRight select and focus the next tab (wrapping), ArrowUp goes back, Home/End jump', () => {
    focusEl(tabs()[0])
    press(tabs()[0], 'ArrowDown')
    expect(document.activeElement).toBe(tabs()[1])
    expect(tabs()[1].getAttribute('aria-selected')).toBe('true')
    expect(tabs().map((t) => t.tabIndex)).toEqual([-1, 0, -1, -1, -1, -1])
    press(tabs()[1], 'End')
    expect(document.activeElement).toBe(tabs()[5])
    press(tabs()[5], 'ArrowRight')
    expect(document.activeElement).toBe(tabs()[0]) // Wraps around.
    press(tabs()[0], 'ArrowUp')
    expect(document.activeElement).toBe(tabs()[5])
    press(tabs()[5], 'Home')
    expect(document.activeElement).toBe(tabs()[0])
  })

  test('modifier chords are left alone', () => {
    focusEl(tabs()[0])
    const e = press(tabs()[0], 'ArrowDown', { ctrlKey: true })
    expect(e.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(tabs()[0])
  })
})
