import { describe, expect, it, vi } from 'vitest'
import { createQuitGuard } from './quit-guard'

const ev = () => {
  let prevented = false
  return { e: { preventDefault: () => (prevented = true) }, prevented: () => prevented }
}

describe('quit guard (I7)', () => {
  it('holds the quit until every task (export cancel, proxy cancel, engine stop) has finished', async () => {
    let finishExport!: () => void
    const tasks = [
      () => new Promise<void>((r) => (finishExport = r)),
      vi.fn(async () => undefined)
    ]
    const quit = vi.fn()
    const g = createQuitGuard({ tasks, quit, timeoutMs: 5000 })
    const x = ev()
    g.onBeforeQuit(x.e)
    expect(x.prevented()).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(quit).not.toHaveBeenCalled()
    finishExport()
    await new Promise((r) => setTimeout(r, 20))
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('quits anyway after the timeout when a task hangs', async () => {
    const quit = vi.fn()
    const g = createQuitGuard({ tasks: [() => new Promise(() => undefined)], quit, timeoutMs: 50 })
    g.onBeforeQuit(ev().e)
    await new Promise((r) => setTimeout(r, 150))
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('a failing task does not block the quit; the second before-quit (from quit()) passes through', async () => {
    const quit = vi.fn()
    const g = createQuitGuard({ tasks: [async () => { throw new Error('x') }], quit, timeoutMs: 1000 })
    g.onBeforeQuit(ev().e)
    await new Promise((r) => setTimeout(r, 20))
    expect(quit).toHaveBeenCalledTimes(1)
    const again = ev()
    g.onBeforeQuit(again.e)
    expect(again.prevented()).toBe(false)
  })

  it('repeated before-quit while running does not start the tasks twice', async () => {
    const task = vi.fn(() => new Promise<void>((r) => setTimeout(r, 30)))
    const g = createQuitGuard({ tasks: [task], quit: () => undefined, timeoutMs: 1000 })
    g.onBeforeQuit(ev().e)
    g.onBeforeQuit(ev().e)
    expect(task).toHaveBeenCalledTimes(1)
  })
})
