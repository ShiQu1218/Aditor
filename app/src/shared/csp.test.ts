import { describe, expect, it } from 'vitest'
import { CSP, cspPlugin } from './csp'

describe('CSP (I2)', () => {
  it('locks scripts to self and forbids eval, inline script, remote connections and plugins', () => {
    expect(CSP).toContain("default-src 'self'")
    expect(CSP).toMatch(/script-src 'self'(;|$)/)
    expect(CSP).not.toContain('unsafe-eval')
    expect(CSP).not.toMatch(/script-src[^;]*unsafe-inline/)
    expect(CSP).toContain("connect-src 'self'")
    expect(CSP).toContain("object-src 'none'")
    expect(CSP).not.toMatch(/https?:/)
  })
  it('allows local files for media and images (thumbnails, source video)', () => {
    expect(CSP).toMatch(/media-src [^;]*file:/)
    expect(CSP).toMatch(/img-src [^;]*file:/)
  })
  it('plugin injects the meta on build but not in the dev server', () => {
    const html = '<html><head><title>x</title></head></html>'
    const p = cspPlugin()
    expect(p.transformIndexHtml(html, {})).toContain('http-equiv="Content-Security-Policy"')
    expect(p.transformIndexHtml(html, { server: {} })).toBe(html)
  })
})
