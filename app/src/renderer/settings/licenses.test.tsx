// @vitest-environment jsdom
// I11: Third-party licenses is now an active settings row that asks main to open the bundled license file.
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

test('Clicking Third-party licenses asks main to open the bundled notices', async () => {
  click(document.getElementById('set-tab-about')!)
  await flush(10)
  const btn = buttonByText(document, settingsI18n.row.about.licenses)!
  expect(btn.disabled).toBe(false)
  click(btn)
  await flush(5)
  expect(openLicenses).toHaveBeenCalledTimes(1)
})
