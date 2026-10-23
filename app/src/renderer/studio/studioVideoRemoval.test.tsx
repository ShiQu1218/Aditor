// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest'
import { buttonByText, cleanupMounted, click, flush, press } from '../../../test/dom'
import { mountStudio, STUDIO_VIDEO, type StudioMount } from '../../../test/studioHarness'
import type { LibraryEntry } from '../../main/library'
import { i18n } from '../i18n'

let studio: StudioMount | undefined
afterEach(() => { cleanupMounted(); studio?.restore(); studio = undefined; vi.restoreAllMocks() })
const entry = (path: string, source: LibraryEntry['source'] = 'recording'): LibraryEntry => ({
  path, source, addedAt: Date.now(), status: 'done', favorite: false, progress: 1
})
const headerRemove = () => document.querySelector<HTMLButtonElement>('.studio-file-row .studio-video-remove')!
const t = i18n.library.card

test('header deletion confirms a recording, removes it once, and stays in the studio', async () => {
  const onBack = vi.fn(), onVideoRemoved = vi.fn()
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  studio = await mountStudio({ onBack, onVideoRemoved, api: { entries: [entry(STUDIO_VIDEO)] } })
  click(headerRemove()); click(headerRemove())
  await flush()
  expect(window.confirm).toHaveBeenCalledWith(t.removeSourceConfirm.replace('{name}', 'long'))
  expect(studio.fake.api.library.remove).toHaveBeenCalledTimes(1)
  expect(studio.fake.api.library.remove).toHaveBeenCalledWith(STUDIO_VIDEO)
  expect(onVideoRemoved).toHaveBeenCalledWith(STUDIO_VIDEO)
  expect(onBack).not.toHaveBeenCalled()
})

test('canceling recording deletion keeps the video and stays in the studio', async () => {
  const onBack = vi.fn()
  vi.spyOn(window, 'confirm').mockReturnValue(false)
  studio = await mountStudio({ onBack, api: { entries: [entry(STUDIO_VIDEO)] } })
  click(headerRemove()); await flush()
  expect(studio.fake.api.library.remove).not.toHaveBeenCalled()
  expect(onBack).not.toHaveBeenCalled()
  expect(headerRemove().disabled).toBe(false)
})

test.each([true, false])('imported videos offer a source-file choice: deleteSource=%s', async (deleteSource) => {
  const onBack = vi.fn(), onVideoRemoved = vi.fn()
  studio = await mountStudio({ onBack, onVideoRemoved, api: { entries: [entry(STUDIO_VIDEO, 'external')] } })
  click(headerRemove()); await flush()
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog).not.toBeNull()
  press(document.body, ' ', { code: 'Space' })
  expect(studio.fake.api.library.remove).not.toHaveBeenCalled()
  click(buttonByText(dialog, deleteSource ? t.deleteSource : t.removeFromLibrary)!)
  await flush()
  expect(studio.fake.api.library.remove).toHaveBeenCalledWith(STUDIO_VIDEO, { deleteSource })
  expect(onVideoRemoved).toHaveBeenCalledWith(STUDIO_VIDEO)
  expect(onBack).not.toHaveBeenCalled()
})

test('card deletion targets that video without opening it or leaving the current video', async () => {
  const onOpenVideo = vi.fn(), onBack = vi.fn()
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  studio = await mountStudio({ onBack, onOpenVideo, api: { entries: [entry(STUDIO_VIDEO), entry('D:/other.mp4')] } })
  const card = Array.from(document.querySelectorAll('.same-day-card-wrap'))
    .find((el) => el.querySelector('.same-day-title')?.getAttribute('title') === 'D:/other.mp4')!
  expect(card.querySelector('button button')).toBeNull()
  click(card.querySelector('.same-day-remove')!); await flush()
  expect(studio.fake.api.library.remove).toHaveBeenCalledWith('D:/other.mp4')
  expect(onOpenVideo).not.toHaveBeenCalled()
  expect(onBack).not.toHaveBeenCalled()
})

test('canceling the imported-video dialog deletes nothing and allows another request', async () => {
  studio = await mountStudio({ api: { entries: [entry(STUDIO_VIDEO, 'external')] } })
  click(headerRemove()); await flush()
  click(buttonByText(document.querySelector('[role="dialog"]')!, t.cancel)!)
  expect(studio.fake.api.library.remove).not.toHaveBeenCalled()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  click(headerRemove()); await flush()
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
})

test('failed deletion shows an error and keeps the studio available for retry', async () => {
  const onBack = vi.fn()
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  studio = await mountStudio({ onBack, api: { entries: [entry(STUDIO_VIDEO)] } })
  studio.fake.api.library.remove.mockRejectedValueOnce(new Error('EBUSY'))
  click(headerRemove()); await flush()
  expect(document.querySelector('.toast')?.textContent).toContain(t.removeFailed)
  expect(onBack).not.toHaveBeenCalled()
  expect(headerRemove().disabled).toBe(false)
})

test('keeping the source synchronously saves pending edits before removing the library entry', async () => {
  studio = await mountStudio({ api: { entries: [entry(STUDIO_VIDEO, 'external')] } })
  studio.fake.api.cache.saveSync.mockClear()
  click(document.querySelector('.hl-accept')!)
  click(headerRemove()); await flush()
  click(buttonByText(document.querySelector('[role="dialog"]')!, t.removeFromLibrary)!)
  await flush()
  const save = studio.fake.api.cache.saveSync
  expect(save).toHaveBeenCalledTimes(1)
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ clips: expect.arrayContaining([expect.objectContaining({ status: 'accepted' })]) }))
  expect(save.mock.invocationCallOrder[0]).toBeLessThan(studio.fake.api.library.remove.mock.invocationCallOrder[0])
  cleanupMounted()
  expect(save).toHaveBeenCalledTimes(1)
})

test('a failed source save aborts library-only removal and allows retry', async () => {
  const onBack = vi.fn()
  studio = await mountStudio({ onBack, api: { entries: [entry(STUDIO_VIDEO, 'external')] } })
  click(document.querySelector('.hl-accept')!)
  studio.fake.api.cache.saveSync.mockReturnValueOnce(false)
  click(headerRemove()); await flush()
  click(buttonByText(document.querySelector('[role="dialog"]')!, t.removeFromLibrary)!)
  await flush()
  expect(studio.fake.api.library.remove).not.toHaveBeenCalled()
  expect(onBack).not.toHaveBeenCalled()
  expect(document.querySelector('.toast-host')?.textContent).toContain(i18n.studio.toast.sourceSaveFailed)
  click(headerRemove()); await flush()
  click(buttonByText(document.querySelector('[role="dialog"]')!, t.removeFromLibrary)!)
  await flush()
  expect(studio.fake.api.library.remove).toHaveBeenCalledTimes(1)
})

test('a removal finishing after unmount updates the owner without navigating', async () => {
  const onBack = vi.fn(), onVideoRemoved = vi.fn()
  let complete!: () => void
  studio = await mountStudio({ onBack, onVideoRemoved, api: { entries: [entry(STUDIO_VIDEO, 'external')] } })
  studio.fake.api.library.remove.mockImplementation(() => new Promise<undefined>((resolve) => { complete = () => resolve(undefined) }))
  click(headerRemove()); await flush()
  click(buttonByText(document.querySelector('[role="dialog"]')!, t.removeFromLibrary)!)
  await flush()
  cleanupMounted()
  complete(); await flush()
  expect(onBack).not.toHaveBeenCalled()
  expect(onVideoRemoved).toHaveBeenCalledWith(STUDIO_VIDEO)
})

test('a library lookup finishing after unmount does not prompt or delete', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
  studio = await mountStudio({ api: { entries: [entry(STUDIO_VIDEO)] } })
  let complete!: (entries: LibraryEntry[]) => void
  studio.fake.api.library.getEntries.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
  click(headerRemove())
  cleanupMounted()
  complete([entry(STUDIO_VIDEO)]); await flush()
  expect(confirm).not.toHaveBeenCalled()
  expect(studio.fake.api.library.remove).not.toHaveBeenCalled()
})
