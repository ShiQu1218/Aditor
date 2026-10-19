import { describe, expect, test } from 'vitest'
import { estimateEta, formatEta, MIN_ELAPSED_MS } from './eta'

describe('estimateEta', () => {
  test('estimateEta returns null below 2% progress and monotonic afterwards', () => {
    // Below 2%, there is not enough data.
    expect(estimateEta(0, 10000)).toBeNull()
    expect(estimateEta(0.01, 10000)).toBeNull()
    expect(estimateEta(0.019, 10000)).toBeNull()

    // Formula: elapsed * (1 - p) / p.
    expect(estimateEta(0.5, 30000)).toBeCloseTo(30000)
    expect(estimateEta(0.25, 30000)).toBeCloseTo(90000)

    // For a fixed total duration T, ETA decreases monotonically as progress increases.
    const T = 600000
    let prev = Number.POSITIVE_INFINITY
    for (let p = 0.02; p <= 0.9; p += 0.02) {
      const eta = estimateEta(p, p * T)
      expect(eta).not.toBeNull()
      expect(eta!).toBeLessThanOrEqual(prev)
      prev = eta!
    }

    // Too little data at the start (less than 3 seconds): do not treat the first observation of 50% as ETA 0.
    expect(MIN_ELAPSED_MS).toBe(3000)
    expect(estimateEta(0.5, 0)).toBeNull()
    expect(estimateEta(0.5, 2999)).toBeNull()
    expect(estimateEta(0.5, 3000)).toBeCloseTo(3000)
    expect(estimateEta(0.019, 60000)).toBeNull()
    expect(estimateEta(0.02, 3000)).toBeCloseTo(147000)

    // Complete/over-complete progress → 0; invalid input → null.
    expect(estimateEta(1, 30000)).toBe(0)
    expect(estimateEta(1.2, 30000)).toBe(0)
    expect(estimateEta(Number.NaN, 30000)).toBeNull()
    expect(estimateEta(0.5, Number.NaN)).toBeNull()
    expect(estimateEta(0.5, -1)).toBeNull()
  })

  test('formatEta rounds to minutes and handles < 1 min', () => {
    expect(formatEta(6 * 60000)).toBe('約剩 6 分')
    expect(formatEta(41 * 60000)).toBe('約剩 41 分')
    expect(formatEta(90000)).toBe('約剩 2 分') // Round 1.5 minutes.
    expect(formatEta(30000)).toBe('約剩 1 分')
    expect(formatEta(29999)).toBe('不到 1 分')
    expect(formatEta(0)).toBe('不到 1 分')
    expect(formatEta(-5)).toBe('不到 1 分')
    expect(formatEta(Number.NaN)).toBe('不到 1 分')
  })
})
