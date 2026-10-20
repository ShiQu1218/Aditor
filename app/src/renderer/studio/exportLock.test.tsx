// @vitest-environment jsdom
// Editing is locked during export: sidebar, project timeline, and source timeline are all inert (not merely rejected silently by the data layer); unlock when export ends.
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanupMounted, click, flush, focusEl, installDomShims, press } from '../../../test/dom'
import { mountStudio, STUDIO_VIDEO, type StudioMount } from '../../../test/studioHarness'

let s: StudioMount | null = null
afterEach(() => {
  cleanupMounted()
  s?.restore()
  s = null
})

const q = <T extends Element = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel)
const qa = <T extends Element = HTMLElement>(sel: string): T[] => Array.from(document.querySelectorAll<T>(sel))
const LOCKED = ['.studio-aside', '.studio-tl', '.plane-head-edit', '.project-lane .track']

describe('export lock', () => {
  test('while an export runs the side panel, project track and source timeline are inert; they unlock when it ends', async () => {
    installDomShims({ width: 1366, height: 768 })
    let finish: (r: unknown) => void = () => undefined
    const onOpenVideo = vi.fn()
    s = await mountStudio({
      onOpenVideo,
      items: [
        { id: 'i1', source: STUDIO_VIDEO, start: 10, end: 20 },
        { id: 'i2', source: STUDIO_VIDEO, start: 100, end: 112 }
      ],
      api: {
        entries: [STUDIO_VIDEO, 'D:/另一場.mp4'].map((path) => ({ path, addedAt: 1, favorite: false, progress: 1, status: 'done' })),
        settings: { defaultOutDir: 'D:/out' },
        overrides: { export: { start: () => new Promise((r) => (finish = r)) } }
      }
    })
    for (const sel of LOCKED) expect(q(sel)!.hasAttribute('inert'), `${sel} before`).toBe(false)

    focusEl(qa('.pclip')[0])
    press(document.activeElement as Element, 'E', { ctrlKey: true, shiftKey: true })
    await flush(30)
    const start = q<HTMLButtonElement>('.xd-foot .btn-accent')!
    expect(start.disabled).toBe(false)
    click(start)
    await flush(30)
    expect(q('.xd')!.getAttribute('data-phase')).toBe('running')

    for (const sel of LOCKED) {
      const el = q(sel)!
      expect(el.hasAttribute('inert'), `${sel} inert`).toBe(true)
      expect(el.getAttribute('aria-disabled'), `${sel} aria-disabled`).toBe('true')
    }
    // Badge state: the project-timeline export button shows progress.
    expect(q('.plane-head .xd-badge')?.textContent).toContain('%')

    // Minimize the drawer and collapse/reopen the sidebar; the newly mounted sidebar must also be inert.
    press(document.activeElement ?? document.body, 'Escape')
    expect(q('.xd')).toBeNull()
    click(q('.same-day-card:not([aria-current])')!)
    expect(onOpenVideo).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('匯出')
    const exportButton = q('.plane-head > .btn-accent')!
    expect(exportButton.closest('[inert]')).toBeNull()
    click(exportButton)
    expect(q('.xd')).not.toBeNull()
    press(document.activeElement ?? document.body, 'Escape')
    press(document.body, 'b', { ctrlKey: true })
    expect(q('.studio-aside')).toBeNull()
    press(document.body, 'b', { ctrlKey: true })
    expect(q('.studio-aside')!.hasAttribute('inert')).toBe(true)

    // The data layer still rejects edits (Delete does not remove a clip).
    const chip = qa('.pclip')[0]
    press(chip, 'Delete')
    expect(qa('.pclip').length).toBe(2)

    finish({ ok: true, outputs: ['D:/out/x.mp4'] })
    await flush(30)
    for (const sel of LOCKED) expect(q(sel)!.hasAttribute('inert'), `${sel} after`).toBe(false)
    expect(q('.studio-aside')!.hasAttribute('aria-disabled')).toBe(false)
  })
})
