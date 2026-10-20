// @vitest-environment jsdom
// I12: show a notice when startup restoration finds a corrupted or newer-version project file (main has preserved the .bak and created an empty project).
import React from 'react'
import { afterEach, expect, test } from 'vitest'
import { createFakeApi, installFakeApi } from '../../../test/fakeApi'
import { Providers } from '../../../test/harness'
import { cleanupMounted, flush, installDomShims, mount } from '../../../test/dom'
import { i18n } from '../i18n'

let restore: (() => void) | null = null
afterEach(() => {
  cleanupMounted()
  restore?.()
  restore = null
})

async function boot(lastError: unknown): Promise<void> {
  installDomShims()
  restore = installFakeApi(
    createFakeApi({
      settings: { lastProjectId: 'p_bad' },
      overrides: { projects: { load: async () => null, lastError: async () => lastError } }
    })
  )
  mount(
    <Providers active="library">
      <div />
    </Providers>
  )
  await flush(40)
}

test('corrupt last project -> toast explains the backup', async () => {
  await boot({ kind: 'corrupt', message: '專案檔損毀（p_bad.json）' })
  expect(document.querySelector('.toast')?.textContent).toContain(i18n.studio.toast.projectRestoreCorrupt)
})

test('newer-version project -> toast says so', async () => {
  await boot({ kind: 'unsupported', message: 'x' })
  expect(document.querySelector('.toast')?.textContent).toContain(i18n.studio.toast.projectRestoreUnsupported)
})

test('no error (or only a transient/save error) -> no restore toast', async () => {
  await boot(null)
  expect(document.querySelector('.toast')).toBeNull()
})
