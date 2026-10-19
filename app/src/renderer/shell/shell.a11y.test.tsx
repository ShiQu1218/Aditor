// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act } from 'react'
import { KEY_TABLE } from '../input/keymap'
import { LibraryScreen } from '../library/LibraryScreen'
import { makeLibraryFixture } from '../dev/libraryFixture'
import { useToast } from './ToastHost'
import { groupKeyRows } from './ShortcutsDialog'
import { createFakeApi, installFakeApi, type FakeApi } from '../../../test/fakeApi'
import { Providers } from '../../../test/harness'
import { byLabel, cleanupMounted, click, flush, focusEl, installDomShims, mount, press } from '../../../test/dom'

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]')
}

describe('shortcuts help dialog (generated from KEY_TABLE)', () => {
  let restore: () => void
  let fake: FakeApi
  beforeEach(async () => {
    installDomShims()
    fake = createFakeApi({ entries: makeLibraryFixture(8, Date.now()).map((e) => ({ ...e, status: 'done' as const, error: undefined })) })
    restore = installFakeApi(fake)
    mount(
      <Providers>
        <LibraryScreen onSelectVideo={() => undefined} onOpenSettings={() => undefined} />
      </Providers>
    )
    await flush()
  })
  afterEach(() => {
    cleanupMounted()
    restore()
  })

  test('the rail keyboard button opens a modal dialog labelled by its heading', () => {
    expect(dialog()).toBeNull()
    const btn = byLabel(document.body, '快捷鍵') as HTMLElement
    expect(btn.getAttribute('aria-haspopup')).toBe('dialog')
    focusEl(btn)
    click(btn)
    const d = dialog()!
    expect(d).not.toBeNull()
    const labelledby = d.getAttribute('aria-labelledby')!
    expect(document.getElementById(labelledby)?.textContent).toBe('快捷鍵說明')
  })

  test('lists every KEY_TABLE row (keys + label), grouped under scope headings', () => {
    click(byLabel(document.body, '快捷鍵') as HTMLElement)
    const d = dialog()!
    const rows = Array.from(d.querySelectorAll<HTMLElement>('[data-command]'))
    expect(rows.map((r) => r.dataset.command).sort()).toEqual(KEY_TABLE.map((r) => r.command).sort())
    for (const r of KEY_TABLE) {
      const row = rows.find((x) => x.dataset.command === r.command)!
      expect(row.textContent).toContain(r.label)
      for (const part of r.keys.split(' ／ ')) expect(row.textContent).toContain(part)
    }
    const headings = Array.from(d.querySelectorAll('h3')).map((h) => h.textContent)
    expect(headings.length).toBe(new Set(KEY_TABLE.map((r) => r.scope)).size)
    expect(new Set(headings).size).toBe(headings.length)
  })

  test('"?" opens it from anywhere outside text inputs; focus moves in and Tab stays inside', () => {
    const open0 = document.querySelector('.vcard-open') as HTMLElement
    focusEl(open0)
    press(open0, '?', { shiftKey: true })
    const d = dialog()!
    expect(d).not.toBeNull()
    expect(d.contains(document.activeElement)).toBe(true)
    for (let i = 0; i < 6; i++) {
      press(document.activeElement as Element, 'Tab')
      expect(d.contains(document.activeElement)).toBe(true)
    }
  })

  test('"?" typed into the search box is text, not a shortcut', () => {
    const search = document.querySelector('input[type="search"], input.lib-search, input') as HTMLInputElement
    focusEl(search)
    press(search, '?', { shiftKey: true })
    expect(dialog()).toBeNull()
  })

  test('Esc closes it even when focus is outside the dialog, and focus returns to the trigger', () => {
    const btn = byLabel(document.body, '快捷鍵') as HTMLElement
    focusEl(btn)
    click(btn)
    expect(dialog()).not.toBeNull()
    act(() => (document.activeElement as HTMLElement).blur())
    expect(document.activeElement).toBe(document.body)
    press(document.body, 'Escape')
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(btn)
  })

  test('Esc inside the dialog also closes it and does not reach the library keymap (search text is kept)', () => {
    const search = document.querySelector('input') as HTMLInputElement
    focusEl(search)
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(search, 'abc')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const btn = byLabel(document.body, '快捷鍵') as HTMLElement
    click(btn)
    press(dialog()!.querySelector('button') as Element, 'Escape')
    expect(dialog()).toBeNull()
    expect(search.value).toBe('abc')
  })

  test('the close button is keyboard reachable and closes the dialog', () => {
    click(byLabel(document.body, '快捷鍵') as HTMLElement)
    const close = byLabel(dialog()!, '關閉') as HTMLElement
    expect(close.tagName).toBe('BUTTON')
    click(close)
    expect(dialog()).toBeNull()
  })
})

describe('groupKeyRows (pure)', () => {
  test('groups rows by scope, keeping table order inside a group, each command once', () => {
    const groups = groupKeyRows(KEY_TABLE)
    expect(groups.flatMap((g) => g.rows).length).toBe(KEY_TABLE.length)
    expect(new Set(groups.map((g) => g.scope)).size).toBe(groups.length)
    expect(groups[0].scope).toBe('全域')
  })
})

describe('toast host: keyboard', () => {
  let restore: () => void
  function Pusher({ run }: { run: () => void }): JSX.Element {
    const toast = useToast()
    return (
      <button id="push" onClick={() => toast({ message: '已加入專案', action: { label: '復原', run } })}>
        push
      </button>
    )
  }
  beforeEach(() => {
    vi.useFakeTimers()
    installDomShims()
    restore = installFakeApi(createFakeApi())
  })
  afterEach(() => {
    cleanupMounted()
    restore()
    vi.useRealTimers()
  })

  test('the Undo action is a real button: focusable, and activating it runs the action and dismisses the toast', () => {
    const run = vi.fn()
    const m = mount(
      <Providers>
        <Pusher run={run} />
      </Providers>
    )
    click(m.container.querySelector('#push') as Element)
    const undo = document.querySelector<HTMLButtonElement>('.toast button')!
    expect(undo.tagName).toBe('BUTTON')
    expect(undo.textContent).toBe('復原')
    focusEl(undo)
    expect(document.activeElement).toBe(undo)
    click(undo)
    expect(run).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.toast')).toBeNull()
  })

  test('keyboard focus on the toast pauses its timer; blur resumes it (not only mouse hover)', () => {
    const m = mount(
      <Providers>
        <Pusher run={() => undefined} />
      </Providers>
    )
    click(m.container.querySelector('#push') as Element)
    const undo = document.querySelector<HTMLButtonElement>('.toast button')!
    focusEl(undo)
    act(() => {
      vi.advanceTimersByTime(60_000) // Far beyond the 6-second TTL.
    })
    expect(document.querySelector('.toast')).not.toBeNull()
    act(() => undo.blur())
    act(() => {
      vi.advanceTimersByTime(7_000)
    })
    expect(document.querySelector('.toast')).toBeNull()
  })

  test('Alt+T moves focus to the newest toast action (so Undo is reachable without tabbing through the page)', () => {
    const m = mount(
      <Providers>
        <Pusher run={() => undefined} />
      </Providers>
    )
    click(m.container.querySelector('#push') as Element)
    focusEl(m.container.querySelector('#push') as HTMLElement)
    press(document.activeElement as Element, 't', { altKey: true })
    expect(document.activeElement).toBe(document.querySelector('.toast button'))
  })
})
