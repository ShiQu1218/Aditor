// @vitest-environment jsdom
// I5：專案自動儲存關閉時，未另存的變更要有提示（回報 main 關窗詢問；新專案／開啟檔案先確認）。
import { afterEach, describe, expect, test, vi } from 'vitest'
import { buttonByText, cleanupMounted, click, flush } from '../../../test/dom'
import { mountStudio, type StudioMount } from '../../../test/studioHarness'
import { i18n } from '../i18n/zh-TW'

let s: StudioMount | null = null
afterEach(() => {
  cleanupMounted()
  s?.restore()
  s = null
})
const T = i18n.studio

async function mountOff(): Promise<StudioMount> {
  const m = await mountStudio({ api: { settings: { projectAutosave: false } } })
  await flush(20)
  return m
}
const accept = async (): Promise<void> => {
  click(document.querySelectorAll('.hl-card')[0].querySelector('.hl-accept')!)
  await flush(5)
}
const dialog = (): HTMLElement | null => document.querySelector('.np-dlg')

describe('unsaved changes with autosave off (I5)', () => {
  test('reports dirty to main only after an edit', async () => {
    s = await mountOff()
    const setDirty = s.fake.api.projects.setDirty as ReturnType<typeof vi.fn>
    expect(setDirty).not.toHaveBeenLastCalledWith(true)
    await accept()
    expect(setDirty).toHaveBeenLastCalledWith(true)
  })

  test('open file with unsaved changes asks first; cancel does not open the file picker', async () => {
    s = await mountOff()
    await accept()
    click(buttonByText(document, T.track.openFile)!)
    await flush(5)
    expect(dialog()?.textContent).toContain(T.openFileDlg.title)
    click(buttonByText(dialog()!, T.openFileDlg.cancel)!)
    await flush(5)
    expect(s.fake.api.project.showOpenDialog).not.toHaveBeenCalled()
  })

  test('open file with unsaved changes -> 〔直接開啟〕 proceeds to the picker', async () => {
    s = await mountOff()
    await accept()
    click(buttonByText(document, T.track.openFile)!)
    await flush(5)
    click(buttonByText(dialog()!, T.openFileDlg.directOpen)!)
    await flush(10)
    expect(s.fake.api.project.showOpenDialog).toHaveBeenCalledTimes(1)
  })

  test('new project dialog warns that unsaved changes would be lost', async () => {
    s = await mountOff()
    await accept()
    click(buttonByText(document, T.track.newProject)!)
    await flush(5)
    expect(dialog()?.textContent).toContain('尚未另存的變更')
  })

  test('main asks to save-and-close: saves the file and reports the result', async () => {
    s = await mountOff()
    await accept()
    ;(s.fake.api.project.showSaveDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce('D:/out/p.apexproj.json')
    ;(s.fake.api.project.save as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true)
    s.fake.emit('projects:saveAndCloseRequest')
    await flush(20)
    expect(s.fake.api.projects.saveAndCloseDone).toHaveBeenCalledWith(true)
  })

  test('save-and-close with the dialog cancelled reports false (window stays open)', async () => {
    s = await mountOff()
    await accept()
    ;(s.fake.api.project.showSaveDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null)
    s.fake.emit('projects:saveAndCloseRequest')
    await flush(20)
    expect(s.fake.api.projects.saveAndCloseDone).toHaveBeenCalledWith(false)
  })
})
