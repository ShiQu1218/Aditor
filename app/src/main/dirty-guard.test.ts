import { describe, expect, it, vi } from 'vitest'
import { createDirtyGuard, type DirtyChoice } from './dirty-guard'

const mk = (choice: DirtyChoice) => {
  const o = { prompt: vi.fn(async () => choice), requestSave: vi.fn(), close: vi.fn() }
  return { o, g: createDirtyGuard(o) }
}
const ev = () => {
  let prevented = false
  return { e: { preventDefault: () => (prevented = true) }, prevented: () => prevented }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('dirty guard (I5)', () => {
  it('lets a clean window close (not handled)', () => {
    const { g } = mk('discard')
    const x = ev()
    expect(g.onClose(x.e)).toBe(false)
    expect(x.prevented()).toBe(false)
  })
  it('dirty: blocks the close and asks; cancel keeps the window open', async () => {
    const { g, o } = mk('cancel')
    g.setDirty(true)
    const x = ev()
    expect(g.onClose(x.e)).toBe(true)
    expect(x.prevented()).toBe(true)
    await tick()
    expect(o.prompt).toHaveBeenCalledTimes(1)
    expect(o.close).not.toHaveBeenCalled()
    expect(g.isDirty()).toBe(true)
  })
  it('discard closes and forgets the dirty flag', async () => {
    const { g, o } = mk('discard')
    g.setDirty(true)
    g.onClose(ev().e)
    await tick()
    expect(o.close).toHaveBeenCalledTimes(1)
    expect(g.isDirty()).toBe(false)
  })
  it('save asks the renderer to save and closes only after saved()', async () => {
    const { g, o } = mk('save')
    g.setDirty(true)
    g.onClose(ev().e)
    await tick()
    expect(o.requestSave).toHaveBeenCalledTimes(1)
    expect(o.close).not.toHaveBeenCalled()
    g.saved()
    expect(o.close).toHaveBeenCalledTimes(1)
  })
  it('a second close while prompting does not open a second prompt', async () => {
    const { g, o } = mk('cancel')
    g.setDirty(true)
    g.onClose(ev().e)
    g.onClose(ev().e)
    await tick()
    expect(o.prompt).toHaveBeenCalledTimes(1)
  })
  it('a cancelled save leaves the window open and the next close asks again', async () => {
    const { g, o } = mk('save')
    g.setDirty(true)
    g.onClose(ev().e)
    await tick()
    g.saveAborted()
    expect(o.close).not.toHaveBeenCalled()
    g.onClose(ev().e)
    await tick()
    expect(o.prompt).toHaveBeenCalledTimes(2)
  })
  it('saved() without a pending save request is ignored', () => {
    const { g, o } = mk('save')
    g.saved()
    expect(o.close).not.toHaveBeenCalled()
  })
})
