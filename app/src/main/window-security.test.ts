import { describe, expect, it } from 'vitest'
import { applyWindowSecurity, type SecureWebContents } from './window-security'

function fake(currentUrl: string) {
  const handlers = new Map<string, (e: { preventDefault(): void }, url?: string) => void>()
  let openHandler: (() => { action: 'deny' }) | null = null
  const wc: SecureWebContents = {
    on: (ev, fn) => void handlers.set(ev, fn),
    setWindowOpenHandler: (h) => {
      openHandler = h
    },
    getURL: () => currentUrl
  }
  const fire = (ev: string, url?: string): boolean => {
    let prevented = false
    handlers.get(ev)?.({ preventDefault: () => (prevented = true) }, url)
    return prevented
  }
  return { wc, fire, open: () => openHandler?.() }
}

describe('applyWindowSecurity (I2)', () => {
  it('blocks navigation to a dropped file or any other URL', () => {
    const f = fake('file:///C:/app/out/renderer/index.html')
    applyWindowSecurity(f.wc)
    expect(f.fire('will-navigate', 'file:///D:/Videos/a.mp4')).toBe(true)
    expect(f.fire('will-navigate', 'file:///D:/evil.html')).toBe(true)
    expect(f.fire('will-navigate', 'https://example.com/')).toBe(true)
  })
  it('allows a same-URL reload (dev) but still blocks redirects and webviews', () => {
    const f = fake('http://localhost:5173/')
    applyWindowSecurity(f.wc)
    expect(f.fire('will-navigate', 'http://localhost:5173/#x')).toBe(false)
    expect(f.fire('will-redirect', 'http://localhost:5173/')).toBe(true)
    expect(f.fire('will-attach-webview')).toBe(true)
  })
  it('denies window.open', () => {
    const f = fake('file:///x')
    applyWindowSecurity(f.wc)
    expect(f.open()).toEqual({ action: 'deny' })
  })
})
