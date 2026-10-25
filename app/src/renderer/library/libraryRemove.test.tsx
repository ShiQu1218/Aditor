// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { LibraryScreen } from './LibraryScreen'
import type { LibraryEntry } from '../../main/library'
import { createFakeApi, installFakeApi } from '../../../test/fakeApi'
import { Providers } from '../../../test/harness'
import { buttonByText, cleanupMounted, flush, installDomShims, mount, press } from '../../../test/dom'
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
  return { fake, container }
}

/** Open the card menu and click its "Remove" item. */
function clickRemove(container: ParentNode): void {
  act(() => container.querySelector<HTMLButtonElement>('.vcard-more')!.click())
  const item = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
    .find((button) => button.textContent === i18n.library.card.remove)!
  act(() => item.click())
}

/** The open removal dialog (single video mode). */
function dialog(container: ParentNode): HTMLElement | null {
  return container.querySelector('.lib-dlg')
}

describe('library removal', () => {
  test('a recording is confirmed once and removed without options', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { fake, container } = await setup('recording')
    clickRemove(container)
    await flush()
    expect(confirm).toHaveBeenCalledWith(i18n.library.card.removeSourceConfirm.replace('{name}', 'recorded.mp4'))
    expect(fake.api.library.remove).toHaveBeenCalledWith('D:/recorded.mp4')
    expect(dialog(container)).toBeNull()
  })

  test('does not remove when the confirmation is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { fake, container } = await setup('recording')
    clickRemove(container)
    await flush()
    expect(fake.api.library.remove).not.toHaveBeenCalled()
  })

  test('an imported video opens the removal dialog instead of the browser confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm')
    const { fake, container } = await setup('external')
    clickRemove(container)
    await flush()

    expect(confirm).not.toHaveBeenCalled()
    expect(fake.api.library.remove).not.toHaveBeenCalled()
    const box = dialog(container)!
    expect(box.getAttribute('role')).toBe('dialog')
    expect(box.getAttribute('aria-modal')).toBe('true')
    expect(box.textContent).toContain(i18n.library.card.removeChoiceTitle)
    expect(box.textContent).toContain('recorded.mp4')
    // The focus starts on Cancel, so the destructive choice is never the default.
    expect(document.activeElement?.textContent).toBe(i18n.library.card.cancel)
  })

  test('a legacy entry (without source) opens the same dialog', async () => {
    const confirm = vi.spyOn(window, 'confirm')
    const { container } = await setup(undefined)
    clickRemove(container)
    await flush()
    expect(confirm).not.toHaveBeenCalled()
    expect(dialog(container)).not.toBeNull()
  })

  test('"Delete source file" removes the entry and asks main to delete the file', async () => {
    const { fake, container } = await setup('external')
    clickRemove(container)
    await flush()
    act(() => buttonByText(dialog(container)!, i18n.library.card.deleteSource)!.click())
    await flush()
    expect(fake.api.library.remove).toHaveBeenCalledWith('D:/recorded.mp4', { deleteSource: true })
    expect(dialog(container)).toBeNull()
  })

  test('"Remove from library" keeps the source file', async () => {
    const { fake, container } = await setup('external')
    clickRemove(container)
    await flush()
    act(() => buttonByText(dialog(container)!, i18n.library.card.removeFromLibrary)!.click())
    await flush()
    expect(fake.api.library.remove).toHaveBeenCalledWith('D:/recorded.mp4', { deleteSource: false })
    expect(dialog(container)).toBeNull()
  })

  test('Cancel closes the dialog without removing anything', async () => {
    const { fake, container } = await setup('external')
    clickRemove(container)
    await flush()
    act(() => buttonByText(dialog(container)!, i18n.library.card.cancel)!.click())
    await flush()
    expect(fake.api.library.remove).not.toHaveBeenCalled()
    expect(dialog(container)).toBeNull()
  })

  test('Esc closes the dialog without removing anything', async () => {
    const { fake, container } = await setup('external')
    clickRemove(container)
    await flush()
    expect(dialog(container)).not.toBeNull()
    press(document.body, 'Escape')
    await flush()
    expect(fake.api.library.remove).not.toHaveBeenCalled()
    expect(dialog(container)).toBeNull()
  })

  test('a click on the scrim cancels the dialog', async () => {
    const { fake, container } = await setup('external')
    clickRemove(container)
    await flush()
    const scrim = container.querySelector('.lib-dlg-scrim') as HTMLElement
    act(() => {
      scrim.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    await flush()
    expect(fake.api.library.remove).not.toHaveBeenCalled()
    expect(dialog(container)).toBeNull()
  })

  test('surfaces file deletion errors and retains the card', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { fake, container } = await setup('recording')
    fake.api.library.remove.mockRejectedValueOnce(new Error('EBUSY'))
    clickRemove(container)
    await flush()
    expect(document.querySelector('.toast')?.textContent).toContain(i18n.library.card.removeFailed)
    expect(document.querySelector('.vcard')).not.toBeNull()
  })

  test('an error after choosing a removal shows the same toast', async () => {
    const { fake, container } = await setup('external')
    fake.api.library.remove.mockRejectedValueOnce(new Error('EBUSY'))
    clickRemove(container)
    await flush()
    act(() => buttonByText(dialog(container)!, i18n.library.card.deleteSource)!.click())
    await flush()
    expect(document.querySelector('.toast')?.textContent).toContain(i18n.library.card.removeFailed)
    expect(document.querySelector('.vcard')).not.toBeNull()
  })
})
