import { describe, it, expect } from 'vitest'
import { resolveCaptureMethod, supportsBorderlessCapture } from './capture-method'

describe('capture method', () => {
  it('detects borderless window capture from the Windows build number', () => {
    expect(supportsBorderlessCapture('10.0.19045', 'win32')).toBe(false)
    expect(supportsBorderlessCapture('10.0.20348', 'win32')).toBe(true)
    expect(supportsBorderlessCapture('10.0.26100', 'win32')).toBe(true)
    // Unparseable releases and other platforms keep window capture.
    expect(supportsBorderlessCapture('unknown', 'win32')).toBe(true)
    expect(supportsBorderlessCapture('6.5.0', 'linux')).toBe(true)
  })

  it('resolves auto to screen capture only where window capture shows the yellow border', () => {
    expect(resolveCaptureMethod('auto', false)).toBe('dda')
    expect(resolveCaptureMethod('auto', true)).toBe('wgc')
  })

  it('keeps an explicit choice on every Windows version', () => {
    expect(resolveCaptureMethod('hook', false)).toBe('hook')
    expect(resolveCaptureMethod('hook', true)).toBe('hook')
    expect(resolveCaptureMethod('wgc', false)).toBe('wgc')
    expect(resolveCaptureMethod('dda', true)).toBe('dda')
  })
})
