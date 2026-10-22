// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ProjectManagerDialog, type StoredProjectSummary } from './ProjectManagerDialog'
import { buttonByText, cleanupMounted, click, flush, installDomShims, mount, press } from '../../../test/dom'

const entries: StoredProjectSummary[] = [
  { id: 'p_cur', name: '目前專案', updatedAt: 3000, items: 4 },
  { id: 'p_old', name: '舊專案', updatedAt: 2000, items: 2 }
]

function installApi(list: StoredProjectSummary[] = entries) {
  const projects = {
    list: vi.fn(async () => list),
    rename: vi.fn(async () => true),
    remove: vi.fn(async () => true)
  }
  ;(window as unknown as { api: unknown }).api = { projects }
  return projects
}

function rowOf(container: HTMLElement, name: string): HTMLElement {
  const row = Array.from(container.querySelectorAll<HTMLElement>('.pm-row')).find((r) => r.textContent?.includes(name))
  expect(row, `row ${name}`).toBeTruthy()
  return row!
}

beforeEach(() => installDomShims())
afterEach(() => {
  cleanupMounted()
  delete (window as unknown as { api?: unknown }).api
})

describe('ProjectManagerDialog', () => {
  test('lists stored projects and locks the in-use one', async () => {
    installApi()
    const m = mount(<ProjectManagerDialog currentId="p_cur" onClose={() => {}} onOpen={async () => true} />)
    await flush()
    expect(m.container.querySelectorAll('.pm-row')).toHaveLength(2)
    const current = rowOf(m.container, '目前專案')
    expect(current.querySelector('.pm-badge')).not.toBeNull()
    for (const b of Array.from(current.querySelectorAll<HTMLButtonElement>('.pm-actions button'))) expect(b.disabled).toBe(true)
    expect(rowOf(m.container, '舊專案').querySelector('.pm-badge')).toBeNull()
  })

  test('open calls onOpen and closes when the switch succeeds', async () => {
    installApi()
    const onOpen = vi.fn(async () => true)
    const onClose = vi.fn()
    const m = mount(<ProjectManagerDialog currentId="p_cur" onClose={onClose} onOpen={onOpen} />)
    await flush()
    click(buttonByText(rowOf(m.container, '舊專案'), '開啟') as HTMLElement)
    await flush()
    expect(onOpen).toHaveBeenCalledWith('p_old')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('open failure keeps the dialog open and shows an error', async () => {
    installApi()
    const onClose = vi.fn()
    const m = mount(<ProjectManagerDialog currentId="p_cur" onClose={onClose} onOpen={async () => false} />)
    await flush()
    click(buttonByText(rowOf(m.container, '舊專案'), '開啟') as HTMLElement)
    await flush()
    expect(onClose).not.toHaveBeenCalled()
    expect(m.container.querySelector('.pm-error')).not.toBeNull()
  })

  test('delete needs a second confirmation click and then refreshes the list', async () => {
    const api = installApi()
    const m = mount(<ProjectManagerDialog currentId="p_cur" onClose={() => {}} onOpen={async () => true} />)
    await flush()
    click(buttonByText(rowOf(m.container, '舊專案'), '刪除') as HTMLElement)
    expect(api.remove).not.toHaveBeenCalled()
    click(buttonByText(rowOf(m.container, '舊專案'), '確定刪除') as HTMLElement)
    await flush()
    expect(api.remove).toHaveBeenCalledWith('p_old')
    expect(api.list).toHaveBeenCalledTimes(2)
  })

  test('Esc cancels an inline prompt first and only then closes the dialog', async () => {
    installApi()
    const onClose = vi.fn()
    const m = mount(<ProjectManagerDialog currentId="p_cur" onClose={onClose} onOpen={async () => true} />)
    await flush()
    click(buttonByText(rowOf(m.container, '舊專案'), '刪除') as HTMLElement)
    press(document.activeElement as Element, 'Escape')
    expect(onClose).not.toHaveBeenCalled()
    expect(buttonByText(rowOf(m.container, '舊專案'), '確定刪除')).toBeFalsy()
    press(document.activeElement as Element, 'Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('rename saves the draft through the API', async () => {
    const api = installApi()
    const m = mount(<ProjectManagerDialog currentId="p_cur" onClose={() => {}} onOpen={async () => true} />)
    await flush()
    click(buttonByText(rowOf(m.container, '舊專案'), '重新命名') as HTMLElement)
    const input = m.container.querySelector<HTMLInputElement>('.pm-input')!
    expect(input.value).toBe('舊專案')
    // While renaming, the name lives in the input value rather than the row text.
    click(buttonByText(input.closest('.pm-row') as HTMLElement, '儲存') as HTMLElement)
    await flush()
    expect(api.rename).toHaveBeenCalledWith('p_old', '舊專案')
  })

  test('shows the empty state', async () => {
    installApi([])
    const m = mount(<ProjectManagerDialog currentId="p_cur" onClose={() => {}} onOpen={async () => true} />)
    await flush()
    expect(m.container.querySelector('.pm-list')).toBeNull()
    expect(m.container.textContent).toContain('還沒有已儲存的專案')
  })
})
