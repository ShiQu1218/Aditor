// @vitest-environment jsdom
import React, { act } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { LibraryScreen } from './LibraryScreen'
import type { LibraryEntry } from '../../main/library'
import { createFakeApi, installFakeApi } from '../../../test/fakeApi'
import { Providers } from '../../../test/harness'
import { cleanupMounted, flush, installDomShims, mount } from '../../../test/dom'
import { i18n } from '../i18n'

let restore: (() => void) | undefined
afterEach(() => {
  cleanupMounted()
  restore?.()
  vi.restoreAllMocks()
})

async function setup(source?: LibraryEntry['source']) {
  installDomShims()
  const entry: LibraryEntry = { path: 'D:/recorded.mp4', source, status: 'done', progress: 1, favorite: false, addedAt: Date.now() }
  const fake = createFakeApi({ entries: [entry] })
  restore = installFakeApi(fake)
  const { container } = mount(<Providers><LibraryScreen onSelectVideo={() => {}} onOpenSettings={() => {}} /></Providers>)
  await flush()
  act(() => container.querySelector<HTMLButtonElement>('.vcard-more')!.click())
  const remove = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
    .find((button) => button.textContent === i18n.library.card.remove)!
  return { fake, remove }
}

describe('library removal', () => {
  test.each(['recording', 'external', undefined] as const)('confirms the file deletion behavior for %s', async (source) => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { fake, remove } = await setup(source)
    act(() => remove.click())
    await flush()
    const message = source === 'recording' ? i18n.library.card.removeSourceConfirm : i18n.library.card.removeConfirm
    expect(confirm).toHaveBeenCalledWith(message.replace('{name}', 'recorded.mp4'))
    expect(fake.api.library.remove).toHaveBeenCalledWith('D:/recorded.mp4')
  })

  test('does not remove when the confirmation is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { fake, remove } = await setup('recording')
    act(() => remove.click())
    await flush()
    expect(fake.api.library.remove).not.toHaveBeenCalled()
  })

  test('surfaces file deletion errors and retains the card', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { fake, remove } = await setup('recording')
    fake.api.library.remove.mockRejectedValueOnce(new Error('EBUSY'))
    act(() => remove.click())
    await flush()
    expect(document.querySelector('.toast')?.textContent).toContain(i18n.library.card.removeFailed)
    expect(document.querySelector('.vcard')).not.toBeNull()
  })
})
