// @vitest-environment jsdom
// I11：設定頁「第三方授權」不再是停用列，按下去會請 main 開啟隨安裝包附帶的授權檔。
import React from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { SettingsScreen } from './SettingsScreen'
import { SETTING_ROWS } from './rows'
import { createFakeApi, installFakeApi } from '../../../test/fakeApi'
import { Providers } from '../../../test/harness'
import { buttonByText, cleanupMounted, click, flush, installDomShims, mount } from '../../../test/dom'
import { settingsI18n } from '../i18n'

let restore: () => void
let openLicenses: ReturnType<typeof vi.fn>
beforeEach(async () => {
  installDomShims()
  const fake = createFakeApi({ overrides: { app: { openLicenses: (openLicenses = vi.fn(async () => true)) } } })
  ;(fake.api as unknown as Record<string, unknown>).app ??= { openLicenses }
  restore = installFakeApi(fake)
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

test('the about row is not disabled', () => {
  expect(SETTING_ROWS.find((r) => r.id === 'about')!.disabledReason).toBeUndefined()
})

test('clicking 〔第三方授權〕 asks main to open the bundled notices', async () => {
  click(document.querySelectorAll<HTMLElement>('[role="tab"]')[2])
  await flush(10)
  const btn = buttonByText(document, settingsI18n.row.about.licenses)!
  expect(btn.disabled).toBe(false)
  click(btn)
  await flush(5)
  expect(openLicenses).toHaveBeenCalledTimes(1)
})
