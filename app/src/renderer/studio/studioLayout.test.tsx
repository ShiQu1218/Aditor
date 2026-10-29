// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest'
import { act } from 'react'
import { buttonByText, cleanupMounted, click, flush, press } from '../../../test/dom'
import { mountStudio, type StudioMount } from '../../../test/studioHarness'
import { i18n } from '../i18n'

let s: StudioMount | null = null
afterEach(() => {
  cleanupMounted()
  s?.restore()
  s = null
})
const T = i18n.studio

describe('Studio layout and interactions', () => {
  test('Shows only highlights; keeps transport event counts and filters, removes Ctrl+M/Ctrl+S', async () => {
    s = await mountStudio()
    expect(document.querySelector('.studio-aside')?.getAttribute('aria-label')).toBe('精華')
    expect(document.querySelector('.hl-tab')?.getAttribute('aria-labelledby')).toBe('aside-tab-hl')
    expect(document.querySelectorAll('[role="tab"], .ev-tab, .ev-row, .tri')).toHaveLength(0)
    const chip = document.querySelector<HTMLButtonElement>('.transport .chip')!
    const before = chip.getAttribute('aria-pressed')
    click(chip)
    expect(chip.getAttribute('aria-pressed')).not.toBe(before)
    press(document.body, 'm', { ctrlKey: true })
    press(document.body, 's', { ctrlKey: true })
    expect(document.querySelectorAll('.pclip')).toHaveLength(0)
    expect(document.querySelector('.toast')).toBeNull()
  })

  test('Quick Clip and AI are left of event stats; Export is right of Add External Video and opens the drawer', async () => {
    s = await mountStudio()
    const transport = document.querySelector('.transport')!
    const quick = buttonByText(transport, T.quickClip)!
    const ai = buttonByText(transport, T.autoClip)!
    const filter = transport.querySelector('.event-chips') ?? transport.querySelector('[aria-label="事件類型篩選"]')!
    expect(quick.compareDocumentPosition(filter) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(ai.compareDocumentPosition(filter) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(document.querySelector('.studio-head')?.textContent).not.toContain(T.quickClip)
    const buttons = Array.from(document.querySelectorAll('.plane-head button')).slice(-4)
    expect(buttons.map((b) => b.textContent?.trim())).toEqual([
      T.track.newProject,
      T.track.projectManager,
      T.track.addExternalVideo,
      T.exportCount.replace('{n}', '0')
    ])
    click(quick)
    expect(quick.getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelectorAll('.pclip')).toHaveLength(0)
    const exportButton = document.querySelector('.plane-head > .btn-accent')!
    click(exportButton)
    await flush(20)
    expect(exportButton.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('.xd')).not.toBeNull()
  })

  test('AI button keeps its popover toggle and anchor', async () => {
    s = await mountStudio()
    const ai = document.querySelector<HTMLButtonElement>('.transport [data-autoclip="toggle"]')!
    ai.getBoundingClientRect = () => ({ top: 450, left: 500, bottom: 480, right: 620, width: 120, height: 30, x: 500, y: 450, toJSON: () => ({}) })
    click(ai)
    const pop = document.querySelector<HTMLElement>('.autoclip-pop')!
    expect(ai.getAttribute('aria-expanded')).toBe('true')
    expect(pop.style.left).toBe('500px')
    click(ai)
    expect(document.querySelector('.autoclip-pop')).toBeNull()
    expect(ai.getAttribute('aria-expanded')).toBe('false')
  })

  test('Add External Video selects files, adds them to the library and analysis queue, adds them all to the project, and plays the first clip', async () => {
    const paths = ['D:/a.mp4', 'D:/b.mp4']
    const select = vi.fn(async () => paths)
    const add = vi.fn(async () => undefined)
    const enqueue = vi.fn(async () => undefined)
    const onOpenVideo = vi.fn()
    s = await mountStudio({ onOpenVideo, api: { overrides: { library: { selectFiles: select, add }, queue: { enqueue }, engine: { probe: async () => ({ duration: 120 }) } } } })
    click(buttonByText(document, T.track.addExternalVideo)!)
    await flush()
    expect(select).toHaveBeenCalledTimes(1)
    expect(add).toHaveBeenCalledWith(paths)
    expect(enqueue.mock.calls).toEqual([['D:/a.mp4'], ['D:/b.mp4']])
    expect(add.mock.invocationCallOrder[0]).toBeLessThan(enqueue.mock.invocationCallOrder[0])
    expect(document.querySelectorAll('.pclip')).toHaveLength(2)
    expect(onOpenVideo).toHaveBeenCalledWith(paths[0], expect.objectContaining({ playItemId: document.querySelector('.pclip')!.getAttribute('data-item-id') }))
    press(document.body, 'z', { ctrlKey: true })
    expect(document.querySelectorAll('.pclip')).toHaveLength(0)
  })

  test('Canceling file selection does not import or analyze', async () => {
    s = await mountStudio()
    click(buttonByText(document, T.track.addExternalVideo)!)
    await flush()
    expect(s.fake.api.library.add).not.toHaveBeenCalled()
    expect(s.fake.api.queue.enqueue).not.toHaveBeenCalled()
  })

  test('closing the project manager and creating a project invalidates an earlier pending load', async () => {
    let resolve!: (project: unknown) => void
    const pending = new Promise((done) => { resolve = done })
    const initial = { version: 1, name: 'Initial', items: [{ id: 'initial', source: 'fixture://long', start: 0, end: 1 }] }
    const load = vi.fn((id: string) => id === 'p_test' ? Promise.resolve(initial) : pending)
    s = await mountStudio({ api: { overrides: { projects: {
      load,
      list: async () => [{ id: 'p_old', name: 'Stored', updatedAt: 1, items: 1 }]
    } } } })
    click(buttonByText(document, T.track.projectManager)!)
    await flush()
    click(buttonByText(document.querySelector('.pm-row')!, T.projectManagerDlg.open)!)
    await flush()
    expect(load).toHaveBeenCalledWith('p_old')
    click(buttonByText(document.querySelector('.pm-dlg')!, T.projectManagerDlg.close)!)
    click(buttonByText(document, T.track.newProject)!)
    click(document.querySelector('.np-dlg .btn-accent')!)
    expect(document.querySelectorAll('.pclip')).toHaveLength(0)
    await act(async () => resolve({ ...initial, name: 'Stored' }))
    await flush()
    expect(document.querySelectorAll('.pclip')).toHaveLength(0)
  })

  test.each(['selection', 'probe'] as const)('an external-video import cannot add to a project opened during %s', async (stage) => {
    let resolve!: (value: any) => void
    const delayed = new Promise((done) => { resolve = done })
    const onOpenVideo = vi.fn()
    s = await mountStudio({ onOpenVideo, items: [{ id: 'old', source: 'fixture://long', start: 0, end: 1 }], api: { overrides: {
      library: { selectFiles: () => stage === 'selection' ? delayed : Promise.resolve(['D:/external.mp4']) },
      engine: { probe: () => stage === 'probe' ? delayed : Promise.resolve({ duration: 42 }) }
    } } })
    click(buttonByText(document, T.track.addExternalVideo)!)
    await flush()
    click(buttonByText(s.m.container, T.track.newProject)!)
    click(document.querySelector('.np-dlg .btn-accent')!)
    await act(async () => resolve(stage === 'selection' ? ['D:/external.mp4'] : { duration: 42 }))
    await flush()
    expect(document.querySelectorAll('.pclip')).toHaveLength(0)
    expect(onOpenVideo).not.toHaveBeenCalled()
    if (stage === 'selection') expect(s.fake.api.library.add).not.toHaveBeenCalled()
  })

  test('A partial duration-probe failure shows a notice, keeps library imports, and plays the other successfully added clips', async () => {
    const onOpenVideo = vi.fn()
    s = await mountStudio({
      onOpenVideo,
      api: { overrides: {
        library: { selectFiles: async () => ['D:/bad.mp4', 'D:/good.mp4'] },
        engine: { probe: async (path: string) => path.includes('bad') ? null : { duration: 42 } }
      } }
    })
    click(buttonByText(document, T.track.addExternalVideo)!)
    await flush()
    expect(s.fake.api.library.add).toHaveBeenCalledWith(['D:/bad.mp4', 'D:/good.mp4'])
    expect(s.fake.api.library.remove).not.toHaveBeenCalled()
    expect(document.querySelector('.toast')?.textContent).toContain('bad.mp4')
    expect(document.querySelectorAll('.pclip')).toHaveLength(1)
    expect(onOpenVideo).toHaveBeenCalledWith('D:/good.mp4', expect.anything())
  })

  test('Import failure shows a notice and does not enqueue analysis', async () => {
    s = await mountStudio({ api: { overrides: { library: { selectFiles: async () => ['D:/a.mp4'], add: async () => { throw new Error('失敗') } } } } })
    click(buttonByText(document, T.track.addExternalVideo)!)
    await flush()
    expect(document.querySelector('.toast')?.textContent).toContain(T.toast.addExternalFailed)
    expect(s.fake.api.queue.enqueue).not.toHaveBeenCalled()
  })
})
