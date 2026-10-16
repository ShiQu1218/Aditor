// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { installGlobalDropGuard } from './dropGuard'

describe('installGlobalDropGuard (I2)', () => {
  it('prevents the default navigation for drops and dragovers anywhere in the document', () => {
    const off = installGlobalDropGuard(document)
    const target = document.createElement('div')
    document.body.appendChild(target)
    for (const type of ['dragover', 'drop']) {
      const ev = new Event(type, { bubbles: true, cancelable: true })
      target.dispatchEvent(ev)
      expect(ev.defaultPrevented).toBe(true)
    }
    off()
    const after = new Event('drop', { bubbles: true, cancelable: true })
    target.dispatchEvent(after)
    expect(after.defaultPrevented).toBe(false)
  })
})
