// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act } from 'react'
import { AddEventDialog } from './AddEventDialog'
import { AutoClipPopover } from './AutoClipPopover'
import { ProjectTrack, type ProjectTrackProps } from './ProjectTrack'
import { ExportDrawer } from './ExportDrawer'
import { createExportController } from './exportController'
import { createProject } from '../editor/project'
import { LibraryScreen } from '../library/LibraryScreen'
import { makeLibraryFixture } from '../dev/libraryFixture'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { createFakeApi, installFakeApi } from '../../../test/fakeApi'
import { Providers } from '../../../test/harness'
import { buttonByText, byLabel, cleanupMounted, click, flush, focusEl, installDomShims, mount, press } from '../../../test/dom'

function expectModalDialog(d: HTMLElement | null): HTMLElement {
  expect(d).not.toBeNull()
  expect(d!.getAttribute('role')).toBe('dialog')
  const id = d!.getAttribute('aria-labelledby')
  expect(id, 'aria-labelledby').toBeTruthy()
  expect(document.getElementById(id!)?.textContent?.length).toBeGreaterThan(0)
  return d!
}

function tabAround(box: HTMLElement, times: number): void {
  for (let i = 0; i < times; i++) {
    press(document.activeElement as Element, 'Tab', { shiftKey: i % 2 === 1 })
    expect(box.contains(document.activeElement), `Tab #${i}`).toBe(true)
  }
}

beforeEach(() => installDomShims())
afterEach(() => cleanupMounted())

describe('AddEventDialog', () => {
  function setup() {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    const holder = document.createElement('div')
    document.body.appendChild(holder)
    holder.innerHTML = '<button id="trig">M</button>'
    const trig = document.getElementById('trig') as HTMLButtonElement
    trig.focus()
    const m = mount(<AddEventDialog time={12} onCancel={onCancel} onConfirm={onConfirm} />)
    return { onCancel, onConfirm, trig, m }
  }

  test('modal dialog with a labelling heading; focus enters it; Tab/Shift+Tab stay inside', () => {
    const { m } = setup()
    const d = expectModalDialog(m.container.querySelector('[role="dialog"]'))
    expect(d.getAttribute('aria-modal')).toBe('true')
    expect(d.contains(document.activeElement)).toBe(true)
    tabAround(d, 8)
  })

  test('Esc cancels exactly once', () => {
    const { onCancel } = setup()
    press(document.activeElement as Element, 'Escape')
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  test('Enter on the Cancel button never confirms (the button owns its Enter)', () => {
    const { onConfirm, m } = setup()
    const cancel = buttonByText(m.container, '取消') as HTMLButtonElement
    focusEl(cancel)
    const e = press(cancel, 'Enter')
    expect(onConfirm).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false) // Not intercepted: native button behavior (triggering cancel) proceeds as usual.
  })

  test('Enter on the dialog itself confirms the selected type', () => {
    const { onConfirm, m } = setup()
    const box = m.container.querySelector('[role="dialog"]') as HTMLElement
    focusEl(box)
    press(box, 'Enter')
    expect(onConfirm).toHaveBeenCalledWith('knock')
  })

  test('unmounting returns focus to the element that opened it', () => {
    const { trig, m } = setup()
    expect(document.activeElement).not.toBe(trig)
    m.unmount()
    expect(document.activeElement).toBe(trig)
  })
})

describe('AutoClipPopover', () => {
  test('dialog semantics, initial focus, trap, Esc, focus restore', () => {
    document.body.innerHTML = '<button id="trig" data-autoclip="toggle">AI</button>'
    const trig = document.getElementById('trig') as HTMLButtonElement
    trig.focus()
    const onClose = vi.fn()
    const m = mount(
      <AutoClipPopover defaults={DEFAULT_SETTINGS.autoclip} events={[]} duration={100} onClose={onClose} onApply={() => undefined} />
    )
    const d = expectModalDialog(m.container.querySelector('[role="dialog"]'))
    expect(d.contains(document.activeElement)).toBe(true)
    tabAround(d, 14)
    press(document.activeElement as Element, 'Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
    m.unmount()
    expect(document.activeElement).toBe(trig)
  })
})

describe('new-project dialog (ProjectTrack)', () => {
  function trackProps(): ProjectTrackProps {
    const project = { ...createProject('我的專案'), items: [{ id: 'a', source: 'D:/v.mp4', start: 1, end: 9 }] }
    return {
      project,
      collapsed: false,
      onToggleCollapsed: () => undefined,
      selectedId: null,
      onSelect: () => undefined,
      currentId: null,
      progress: 0,
      labelOf: () => '精華片段',
      missingIds: new Set(),
      saveState: 'saved',
      videoPath: 'D:/v.mp4',
      videoDuration: 100,
      onPlay: () => undefined,
      onMissing: () => undefined,
      onTrim: () => undefined,
      onMove: () => undefined,
      onRename: () => undefined,
      onSplit: () => undefined,
      onDuplicate: () => undefined,
      onDelete: () => undefined,
      onUndo: () => undefined,
      onRedo: () => undefined,
      canUndo: false,
      canRedo: false,
      projectId: 'p_test',
      onNewProject: vi.fn(),
      onOpenProject: vi.fn(async () => true),
      onAddExternalVideo: () => undefined,
      onExport: () => undefined,
      exportOpen: false,
      exportPercent: null,
      onAddFromSource: () => undefined,
      onDialogOpenChange: () => undefined
    }
  }

  test('Opens as a labelled modal dialog, traps Tab, closes on Esc, and returns focus to the New Project button', () => {
    const m = mount(<ProjectTrack {...trackProps()} />)
    const trigger = buttonByText(m.container, '新專案') as HTMLButtonElement
    focusEl(trigger)
    click(trigger)
    const d = expectModalDialog(m.container.querySelector('.np-dlg'))
    expect(d.getAttribute('aria-modal')).toBe('true')
    expect(d.contains(document.activeElement)).toBe(true)
    tabAround(d, 7)
    press(document.activeElement as Element, 'Escape')
    expect(m.container.querySelector('.np-dlg')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  test('confirm calls onNewProject from the keyboard-reachable button', () => {
    const props = trackProps()
    const m = mount(<ProjectTrack {...props} />)
    click(buttonByText(m.container, '新專案') as HTMLElement)
    const direct = m.container.querySelector('.np-dlg .btn-accent') as HTMLElement
    click(direct)
    expect(props.onNewProject).toHaveBeenCalledWith(false)
  })
})

describe('queue popover', () => {
  test('rail button opens a labelled dialog, focus moves in, Esc closes and focus goes back to the rail button', async () => {
    const restore = installFakeApi(createFakeApi({ entries: makeLibraryFixture(4, Date.now()).map((e) => ({ ...e, status: 'done' as const, error: undefined })) }))
    try {
      mount(
        <Providers>
          <LibraryScreen onSelectVideo={() => undefined} onOpenSettings={() => undefined} />
        </Providers>
      )
      await flush()
      const rail = byLabel(document.body, '分析佇列') as HTMLElement
      focusEl(rail)
      click(rail)
      expect(rail.getAttribute('aria-haspopup')).toBe('dialog')
      expect(rail.getAttribute('aria-expanded')).toBe('true')
      const d = expectModalDialog(document.querySelector('.qpop'))
      expect(d.contains(document.activeElement)).toBe(true)
      tabAround(d, 3)
      press(document.activeElement as Element, 'Escape')
      expect(document.querySelector('.qpop')).toBeNull()
      expect(document.activeElement).toBe(rail)
      expect(rail.getAttribute('aria-expanded')).toBe('false')
    } finally {
      restore()
    }
  })
})

describe('export drawer', () => {
  function drawer() {
    const fake = createFakeApi()
    const restore = installFakeApi(fake)
    const ctl = createExportController(
      {
        detectEncoders: async () => [],
        openh264Status: async () => ({ installed: false }),
        downloadOpenH264: async () => 'x',
        selectOutDir: async () => null,
        openFolder: async () => true,
        start: async () => ({ ok: true as const, outputs: [] }),
        cancel: async () => ({ cancelled: false }),
        diskSpace: async () => ({ freeBytes: 1e12, totalBytes: 2e12 }),
        checkOutDir: async () => ({ ok: true as const }),
        onProgress: () => () => undefined,
        onOpenH264Progress: () => () => undefined
      },
      'hl'
    )
    return { ctl, restore }
  }

  test('labelled modal dialog; Tab trapped; Esc closes; the OpenH264 consent dialog is also labelled and traps focus', async () => {
    const { ctl, restore } = drawer()
    try {
      document.body.insertAdjacentHTML('afterbegin', '<button id="trig">匯出</button>')
      const trig = document.getElementById('trig') as HTMLButtonElement
      trig.focus()
      const onClose = vi.fn()
      const project = { ...createProject('p'), items: [{ id: 'a', source: 'D:/v.mp4', start: 1, end: 9 }] }
      const m = mount(<ExportDrawer controller={ctl} project={project} base={null} onClose={onClose} />)
      await flush()
      const d = expectModalDialog(m.container.querySelector('.xd'))
      expect(d.getAttribute('aria-modal')).toBe('true')
      expect(d.contains(document.activeElement)).toBe(true)
      tabAround(d, 6)

      // Consent dialog.
      await act(async () => {
        await ctl.setQuality('precise')
      })
      const consent = expectModalDialog(m.container.querySelector('.xd-consent'))
      expect(consent.contains(document.activeElement)).toBe(true)
      tabAround(consent, 5)
      press(document.activeElement as Element, 'Escape') // Decline consent without closing the drawer.
      expect(m.container.querySelector('.xd-consent')).toBeNull()
      expect(onClose).not.toHaveBeenCalled()

      press(document.activeElement as Element, 'Escape')
      expect(onClose).toHaveBeenCalledTimes(1)
      m.unmount()
      expect(document.activeElement).toBe(trig)
    } finally {
      restore()
    }
  })
})

describe('card ⋯ menu', () => {
  test('role=menu: first item focused on open, Arrow keys wrap, Home/End, Esc closes and returns focus to ⋯', async () => {
    const entries = makeLibraryFixture(4, Date.now()).map((e) => ({ ...e, status: 'done' as const, error: undefined }))
    const restore = installFakeApi(createFakeApi({ entries }))
    try {
      mount(
        <Providers>
          <LibraryScreen onSelectVideo={() => undefined} onOpenSettings={() => undefined} />
        </Providers>
      )
      await flush()
      const card = document.querySelector('.vcard') as HTMLElement
      const more = card.querySelector('.vcard-more') as HTMLButtonElement
      focusEl(more)
      click(more)
      const menu = card.querySelector('[role="menu"]') as HTMLElement
      expect(menu).not.toBeNull()
      expect(menu.getAttribute('aria-labelledby')).toBe(more.id)
      const items = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      // Reanalyze, re-analyze as the other game, remove.
      expect(items.length).toBe(3)
      const last = items[2]
      expect(document.activeElement).toBe(items[0])
      press(items[0], 'ArrowDown')
      expect(document.activeElement).toBe(items[1])
      press(items[1], 'ArrowDown')
      press(last, 'ArrowDown')
      expect(document.activeElement).toBe(items[0]) // Wrap around.
      press(items[0], 'ArrowUp')
      expect(document.activeElement).toBe(last)
      press(last, 'Home')
      expect(document.activeElement).toBe(items[0])
      press(items[0], 'End')
      expect(document.activeElement).toBe(last)
      press(last, 'Escape')
      expect(card.querySelector('[role="menu"]')).toBeNull()
      expect(document.activeElement).toBe(more)
      expect(more.getAttribute('aria-expanded')).toBe('false')
    } finally {
      restore()
    }
  })
})
