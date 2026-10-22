// @vitest-environment jsdom
import React from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { LibraryScreen } from './LibraryScreen'
import type { LibraryEntry } from '../../main/library'
import { createFakeApi, installFakeApi, type FakeApi } from '../../../test/fakeApi'
import { Providers } from '../../../test/harness'
import { buttonByText, byLabel, cleanupMounted, click, flush, installDomShims, mount, press } from '../../../test/dom'
import { i18n } from '../i18n'

let restore: (() => void) | undefined

afterEach(() => {
  cleanupMounted()
  restore?.()
  vi.restoreAllMocks()
})

const NOW = Date.now()
const t = i18n.library.selection

function entry(name: string, over: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    path: `D:/v/${name}.mp4`,
    addedAt: NOW,
    favorite: false,
    status: 'done',
    progress: 1,
    durationSec: 600,
    codec: 'h264',
    ...over
  }
}

interface SetupOptions {
  /** Entry names (without path) whose source is a recording. */
  recordings?: string[]
}

async function setup(opts: SetupOptions = {}) {
  installDomShims()
  const entries: LibraryEntry[] = [
    entry('a', { status: 'done' }),
    entry('b', { status: 'pending', progress: 0 }),
    entry('c', { status: 'analyzing', progress: 0.4, analyzingSince: NOW - 5000 }),
    entry('d', { status: 'error', error: 'moov atom not found' })
  ].map((e, i) => ({
    ...e,
    addedAt: NOW - i * 1000,
    ...(opts.recordings?.includes(e.path.split('/').pop()!.replace('.mp4', '')) ? { source: 'recording' as const } : {})
  }))
  const fake = createFakeApi({ entries })
  restore = installFakeApi(fake)
  const onSelect = vi.fn()
  const m = mount(
    <Providers>
      <LibraryScreen onSelectVideo={onSelect} onOpenSettings={() => undefined} />
    </Providers>
  )
  await flush()
  return { fake, container: m.container, onSelect, entries }
}

function cards(container: ParentNode): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.vcard'))
}

function card(container: ParentNode, name: string): HTMLElement {
  return cards(container).find((c) => c.dataset.vcardPath?.endsWith(`/${name}.mp4`))!
}

function count(container: ParentNode): string {
  return container.querySelector('.lib-selection-count')?.textContent?.trim() ?? ''
}

function checkbox(container: ParentNode, name: string): HTMLButtonElement {
  return card(container, name).querySelector('.vcard-select') as HTMLButtonElement
}

function groupButton(container: ParentNode): HTMLButtonElement {
  return container.querySelector('.lib-group-select') as HTMLButtonElement
}

function bar(container: ParentNode): HTMLElement | null {
  return container.querySelector('.lib-selection-bar')
}

/** The open removal dialog (multi-item mode). */
function dialog(container: ParentNode): HTMLElement {
  return container.querySelector('.lib-dlg') as HTMLElement
}

describe('library selection mode', () => {
  test('a card checkbox enters selection mode, marks the card and shows the bar with count 1', async () => {
    const { container } = await setup()
    expect(bar(container)).toBeNull()

    const box = checkbox(container, 'a')
    expect(box.getAttribute('role')).toBe('checkbox')
    expect(box.getAttribute('aria-checked')).toBe('false')
    expect(box.getAttribute('aria-label')).toBe(t.select.replace('{name}', 'a.mp4'))
    click(box)

    expect(bar(container)).not.toBeNull()
    expect(count(container)).toBe('1')
    expect(card(container, 'a').classList.contains('selected')).toBe(true)
    expect(card(container, 'a').classList.contains('selecting')).toBe(true)
    expect(container.querySelector('.lib-screen')?.classList.contains('selecting')).toBe(true)
    expect(checkbox(container, 'a').getAttribute('aria-checked')).toBe('true')
    // Every card shows a checkbox in selection mode.
    for (const c of cards(container)) expect(c.querySelector('.vcard-select')).not.toBeNull()
  })

  test('in selection mode the card body toggles selection instead of opening, for every status', async () => {
    const { container, onSelect } = await setup()
    click(checkbox(container, 'a'))
    onSelect.mockClear()

    for (const name of ['a', 'b', 'c', 'd']) {
      const open = card(container, name).querySelector('.vcard-open') as HTMLButtonElement
      expect(open.getAttribute('aria-disabled')).toBe('false')
      click(open)
    }
    // a was already selected, so it was deselected; b, c and d were added.
    expect(onSelect).not.toHaveBeenCalled()
    expect(count(container)).toBe('3')
    expect(document.querySelector('.toast')).toBeNull()

    click(card(container, 'b').querySelector('.vcard-open') as HTMLElement)
    expect(count(container)).toBe('2')
    expect(card(container, 'b').classList.contains('selected')).toBe(false)
  })

  test('entries hidden by a filter leave the selection, so Delete never removes unseen videos', async () => {
    const { container, fake } = await setup()
    click(checkbox(container, 'a'))
    click(checkbox(container, 'b'))
    expect(count(container)).toBe('2')

    // Only the finished legacy entry "a" counts as Apex; pending "b" has no game yet and is filtered out.
    click(Array.from(container.querySelectorAll<HTMLButtonElement>('.lib-chip')).find((b) => b.textContent?.includes('Apex Legends'))!)
    await flush()
    expect(count(container)).toBe('1')

    click(container.querySelector<HTMLButtonElement>('.lib-selection-delete')!)
    await flush()
    // Imported videos ask first: keep the source file.
    click(buttonByText(dialog(container), t.removeFromLibraryOnly)!)
    await flush()
    expect(fake.api.library.removeMany).toHaveBeenCalledWith(['D:/v/a.mp4'], { deleteSource: false })
  })

  test('selection mode hides the favorite, menu, analyze and error action buttons', async () => {
    const { container } = await setup()
    click(checkbox(container, 'a'))
    for (const c of cards(container)) {
      expect(c.querySelector('.vcard-fav')).toBeNull()
      expect(c.querySelector('.vcard-more')).toBeNull()
      expect(c.querySelector('.vcard-analyze')).toBeNull()
      expect(c.querySelector('.vcard-error-actions')).toBeNull()
    }
  })

  test('the date header button selects the whole group, then deselects it', async () => {
    const { container } = await setup()
    const selectGroup = groupButton(container)
    expect(selectGroup.getAttribute('aria-label')).toBe(t.selectGroup)
    expect(selectGroup.getAttribute('title')).toBe(t.selectGroup)

    click(selectGroup)
    expect(count(container)).toBe('4')
    expect(groupButton(container).getAttribute('aria-label')).toBe(t.deselectGroup)

    click(groupButton(container))
    expect(count(container)).toBe('0')
    expect(bar(container)).not.toBeNull() // Selection mode stays on until the user exits.
    expect(groupButton(container).getAttribute('aria-label')).toBe(t.selectGroup)
  })

  test('"Select all" selects every shown entry and becomes disabled', async () => {
    const { container } = await setup()
    click(checkbox(container, 'b'))
    expect(count(container)).toBe('1')

    const selectAll = byLabel(container, t.selectAll) as HTMLButtonElement
    expect(selectAll.disabled).toBe(false)
    click(selectAll)
    expect(count(container)).toBe('4')
    expect((byLabel(container, t.selectAll) as HTMLButtonElement).disabled).toBe(true)
  })

  test('when library entries update, selected paths that no longer exist are dropped', async () => {
    const { container, fake, entries } = await setup()
    click(checkbox(container, 'a'))
    click(checkbox(container, 'b'))
    expect(count(container)).toBe('2')

    fake.setEntries(entries.filter((e) => e.path !== entries[0].path))
    fake.emit('library:updated')
    await flush()

    expect(count(container)).toBe('1')
    expect(bar(container)).not.toBeNull()
    expect(card(container, 'b').classList.contains('selected')).toBe(true)
  })

  test('"Delete items" asks about the imported source files and calls removeMany with the selected paths', async () => {
    const confirm = vi.spyOn(window, 'confirm')
    const { container, fake, entries } = await setup()
    click(groupButton(container))
    click(buttonByText(container, t.deleteItems)!)
    await flush()

    // Imported videos ask first: the browser confirmation is not used.
    expect(confirm).not.toHaveBeenCalled()
    const box = dialog(container)
    expect(box.textContent).toContain(t.deleteChoiceTitle.replace('{n}', '4'))
    expect(box.textContent).toContain(t.deleteChoiceMessage.replace('{n}', '4').replace('{m}', '4'))
    click(buttonByText(box, t.deleteSources)!)
    await flush()

    expect(fake.api.library.removeMany).toHaveBeenCalledWith(entries.map((e) => e.path), { deleteSource: true })
    expect(bar(container)).toBeNull() // A successful delete exits selection mode.
  })

  test('a mixed selection notes that recording source files are always deleted', async () => {
    const confirm = vi.spyOn(window, 'confirm')
    const { container, fake, entries } = await setup({ recordings: ['a'] })
    click(checkbox(container, 'a'))
    click(checkbox(container, 'b'))
    click(buttonByText(container, t.deleteItems)!)
    await flush()

    expect(confirm).not.toHaveBeenCalled()
    const box = dialog(container)
    expect(box.textContent).toContain(t.deleteChoiceRecordingNote)
    expect(box.textContent).toContain(t.deleteChoiceMessage.replace('{n}', '2').replace('{m}', '1'))
    click(buttonByText(box, t.removeFromLibraryOnly)!)
    await flush()

    expect(fake.api.library.removeMany).toHaveBeenCalledWith([entries[0].path, entries[1].path], { deleteSource: false })
  })

  test('a selection of recordings only is confirmed once and removed without options', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { container, fake, entries } = await setup({ recordings: ['a', 'b'] })
    click(checkbox(container, 'a'))
    click(checkbox(container, 'b'))
    click(buttonByText(container, t.deleteItems)!)
    await flush()

    expect(confirm).toHaveBeenCalledWith(t.deleteSourceConfirm.replace('{n}', '2'))
    expect(container.querySelector('.lib-dlg')).toBeNull()
    expect(fake.api.library.removeMany).toHaveBeenCalledWith([entries[0].path, entries[1].path])
  })

  test('a cancelled confirmation does not call removeMany', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { container, fake } = await setup({ recordings: ['a'] })
    click(checkbox(container, 'a'))
    click(buttonByText(container, t.deleteItems)!)
    await flush()

    expect(fake.api.library.removeMany).not.toHaveBeenCalled()
    expect(bar(container)).not.toBeNull()
    expect(count(container)).toBe('1')
  })

  test('cancelling the removal dialog keeps the selection and removes nothing', async () => {
    const { container, fake } = await setup()
    click(checkbox(container, 'a'))
    click(buttonByText(container, t.deleteItems)!)
    await flush()

    click(buttonByText(dialog(container), i18n.library.card.cancel)!)
    await flush()
    expect(fake.api.library.removeMany).not.toHaveBeenCalled()
    expect(container.querySelector('.lib-dlg')).toBeNull()
    expect(bar(container)).not.toBeNull()
    expect(count(container)).toBe('1')
  })

  test('Esc closes the removal dialog without exiting selection mode', async () => {
    const { container, fake } = await setup()
    click(checkbox(container, 'a'))
    click(buttonByText(container, t.deleteItems)!)
    await flush()
    expect(container.querySelector('.lib-dlg')).not.toBeNull()

    press(document.body, 'Escape')
    await flush()
    expect(container.querySelector('.lib-dlg')).toBeNull()
    expect(fake.api.library.removeMany).not.toHaveBeenCalled()
    expect(bar(container)).not.toBeNull()
    expect(count(container)).toBe('1')
  })

  test('partial failures keep only the failed paths selected and show a toast', async () => {
    const { container, fake, entries } = await setup()
    fake.api.library.removeMany.mockResolvedValueOnce({ removed: entries.slice(0, 3).map((e) => e.path), failed: [entries[3].path] })
    click(groupButton(container))
    click(buttonByText(container, t.deleteItems)!)
    await flush()
    click(buttonByText(dialog(container), t.deleteSources)!)
    await flush()

    expect(document.querySelector('.toast')?.textContent).toContain(t.deleteFailed.replace('{n}', '1'))
    expect(bar(container)).not.toBeNull()
    expect(count(container)).toBe('1')
    expect(card(container, 'd').classList.contains('selected')).toBe(true)
  })

  test('the close button and Esc both exit selection mode and clear the selection', async () => {
    const { container } = await setup()
    click(checkbox(container, 'a'))
    click(byLabel(container, t.exit)!)

    expect(bar(container)).toBeNull()
    expect(container.querySelector('.lib-screen')?.classList.contains('selecting')).toBe(false)
    expect(cards(container).every((c) => !c.classList.contains('selected'))).toBe(true)

    click(byLabel(container, t.select.replace('{name}', 'a.mp4'))!)
    expect(count(container)).toBe('1')
    press(document.body, 'Escape')
    expect(bar(container)).toBeNull()
    expect(cards(container).every((c) => !c.classList.contains('selected'))).toBe(true)
  })
})
