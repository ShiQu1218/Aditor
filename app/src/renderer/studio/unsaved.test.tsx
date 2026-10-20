// @vitest-environment jsdom
// When autosave is disabled, closing the window or creating a project must still preserve the latest edits.
import { act } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { buttonByText, cleanupMounted, click, flush } from '../../../test/dom'
import { mountStudio, type StudioMount } from '../../../test/studioHarness'
import { i18n } from '../i18n'

let s: StudioMount | null = null
afterEach(() => {
  cleanupMounted()
  s?.restore()
  s = null
})
const T = i18n.studio
const accept = async (): Promise<void> => {
  click(document.querySelector('.hl-accept')!)
  await flush(5)
}

describe('Projects use internal storage only', () => {
  test('Window close saves synchronously even when autosave is off; remount restores the project', async () => {
    s = await mountStudio({ api: { settings: { projectAutosave: false } } })
    await accept()
    expect(s.fake.api.projects.save).not.toHaveBeenCalled()
    act(() => { s!.fake.emit('projects:flushRequest') })
    await flush()
    expect(s.fake.api.projects.flushSync).toHaveBeenCalledTimes(1)
    expect(s.fake.api.projects.flushDone).toHaveBeenCalledWith(true)
    const stored = (s.fake.api.projects.flushSync as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(stored.items).toHaveLength(1)
    s.m.unmount()
    s.restore()
    s = await mountStudio({ api: { overrides: { projects: { load: async () => stored } } } })
    expect(document.querySelectorAll('.pclip')).toHaveLength(1)
  })

  test('A failed synchronous save returns false; retry sends the same content again', async () => {
    s = await mountStudio({ api: { settings: { projectAutosave: false } } })
    await accept()
    ;(s.fake.api.projects.flushSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(false)
    act(() => { s!.fake.emit('projects:flushRequest') })
    await flush()
    expect(s.fake.api.projects.flushDone).toHaveBeenLastCalledWith(false)
    expect(document.querySelector('.sub-save.error')?.textContent).toContain(T.track.saveError)
    act(() => { s!.fake.emit('projects:flushRequest') })
    await flush()
    expect(s.fake.api.projects.flushDone).toHaveBeenLastCalledWith(true)
    expect(s.fake.api.projects.flushSync).toHaveBeenCalledTimes(2)
  })

  test('New project synchronously saves the old project first and no longer offers Save As', async () => {
    s = await mountStudio({ api: { settings: { projectAutosave: false } } })
    await accept()
    click(buttonByText(document, T.track.newProject)!)
    await flush()
    const dialog = document.querySelector('.np-dlg')!
    expect(dialog.textContent).not.toContain('另存')
    expect(dialog.querySelectorAll('button')).toHaveLength(2)
    click(buttonByText(dialog, T.newProjectDlg.confirm)!)
    expect(s.fake.api.projects.flushSync).toHaveBeenCalledTimes(1)
    expect(document.querySelectorAll('.pclip')).toHaveLength(0)
  })

  test('Keeps the original project when saving it before creating a new project fails', async () => {
    s = await mountStudio({ api: { settings: { projectAutosave: false } } })
    await accept()
    ;(s.fake.api.projects.flushSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(false)
    click(buttonByText(document, T.track.newProject)!)
    await flush()
    click(buttonByText(document.querySelector('.np-dlg')!, T.newProjectDlg.confirm)!)
    expect(document.querySelectorAll('.pclip')).toHaveLength(1)
    expect(document.querySelector('.sub-save.error')).not.toBeNull()
  })
})
