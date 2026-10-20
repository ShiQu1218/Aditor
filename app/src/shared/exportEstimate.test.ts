import { describe, expect, it } from 'vitest'
import type { StreamProbe } from './exportCompat'
import { COPY_BYTES_PER_SECOND, PRECISE_BYTES_PER_SECOND, estimateOutputBytes } from './exportEstimate'

const probe = (width = 1920, height = 1080, fps = 60): StreamProbe =>
  ({ vcodec: 'h264', width, height, fps, pix_fmt: 'yuv420p', acodec: 'aac', sample_rate: 48000, channels: 2 })
const project = { items: [{ source: 'a', start: 0, end: 60 }] }
const bytes = (seconds: number, peakKbps: number): number => Math.ceil(seconds * (peakKbps + 192) * 1000 / 8)

describe('estimateOutputBytes', () => {
  it('uses the 1080p60 peak video rate plus AAC audio', () => {
    expect(estimateOutputBytes(project, 'precise', new Map([['a', probe()]]))).toBe(bytes(60, 37_350))
  })

  it('scales 4K60 estimates to the configured 149.25 Mbps peak', () => {
    const estimate = estimateOutputBytes(project, 'precise', new Map([['a', probe(3840, 2160)]]))
    expect(estimate).toBe(bytes(60, 149_250))
    expect(estimate).toBeGreaterThan(60 * PRECISE_BYTES_PER_SECOND * 5)
  })

  it('uses the largest resolution and highest fps for normalized concatenation', () => {
    const mixed = { items: [...project.items, { source: 'b', start: 10, end: 40 }] }
    const probes = new Map([['a', probe(3840, 2160, 30)], ['b', probe()]])
    expect(estimateOutputBytes(mixed, 'precise', probes, 'concat')).toBe(bytes(90, 149_250))
    expect(estimateOutputBytes(mixed, 'precise', probes, 'separate')).toBe(bytes(60, 74_700) + bytes(30, 37_350))
  })

  it('uses the first source when compatible fps differences do not require normalization', () => {
    const mixed = { items: [...project.items, { source: 'b', start: 0, end: 60 }] }
    const probes = new Map([['a', probe(1920, 1080, 59.6)], ['b', probe()]])
    expect(estimateOutputBytes(mixed, 'precise', probes, 'concat')).toBe(bytes(120, 37_050))
  })

  it('falls back to 1080p60 for missing and incomplete probes without reducing the legacy estimate', () => {
    for (const probes of [undefined, new Map<string, StreamProbe>(), new Map([['a', probe(0, 0, 0)]])]) {
      const estimate = estimateOutputBytes(project, 'precise', probes)
      expect(estimate).toBe(bytes(60, 37_350))
      expect(estimate).toBeGreaterThanOrEqual(60 * PRECISE_BYTES_PER_SECOND)
    }
    expect(estimateOutputBytes({ items: [{ start: 0, end: 60 }] }, 'precise')).toBe(bytes(60, 37_350))
  })

  it('retains known high-resolution sources when another probe is missing', () => {
    const mixed = { items: [...project.items, { source: 'missing', start: 0, end: 30 }] }
    const probes = new Map([['a', probe(3840, 2160)]])
    expect(estimateOutputBytes(mixed, 'precise', probes, 'concat')).toBe(bytes(90, 149_250))
    expect(estimateOutputBytes(mixed, 'precise', probes, 'separate')).toBe(bytes(60, 149_250) + bytes(30, 37_350))
  })

  it('leaves copy estimates unchanged regardless of probes and mode', () => {
    for (const mode of ['concat', 'separate'] as const) {
      expect(estimateOutputBytes(project, 'copy', new Map([['a', probe(3840, 2160)]]), mode)).toBe(Math.ceil(60 * COPY_BYTES_PER_SECOND))
    }
  })

  it('preserves copy rounding for fractional durations', () => {
    const fractional = { items: [{ start: 0, end: 0.1 }, { start: 0, end: 0.2 }] }
    expect(estimateOutputBytes(fractional, 'copy')).toBe(Math.ceil((0.1 + 0.2) * COPY_BYTES_PER_SECOND))
  })

  it('ignores empty, negative, and non-finite durations', () => {
    const invalid = { items: [{ start: 0, end: 0 }, { start: 2, end: 1 }, { start: 0, end: Infinity }, { start: NaN, end: 1 }] }
    for (const quality of ['copy', 'precise'] as const) {
      expect(estimateOutputBytes({ items: [] }, quality)).toBe(0)
      expect(estimateOutputBytes(invalid, quality)).toBe(0)
    }
  })
})
