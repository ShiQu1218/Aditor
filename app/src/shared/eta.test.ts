import { describe, expect, test } from 'vitest'
import { estimateEta, formatEta, trackEta } from './eta'

describe('estimateEta', () => {
  test('estimateEta returns null below 2% progress and monotonic afterwards', () => {
    // 2% 以下樣本不足
    expect(estimateEta(0, 10000)).toBeNull()
    expect(estimateEta(0.01, 10000)).toBeNull()
    expect(estimateEta(0.019, 10000)).toBeNull()

    // 公式：elapsed * (1 - p) / p
    expect(estimateEta(0.5, 30000)).toBeCloseTo(30000)
    expect(estimateEta(0.25, 30000)).toBeCloseTo(90000)

    // 固定總時長 T 時，ETA 隨進度單調遞減
    const T = 600000
    let prev = Number.POSITIVE_INFINITY
    for (let p = 0.02; p <= 0.9; p += 0.02) {
      const eta = estimateEta(p, p * T)
      expect(eta).not.toBeNull()
      expect(eta!).toBeLessThanOrEqual(prev)
      prev = eta!
    }

    // 完成／超額進度 → 0；無效輸入 → null
    expect(estimateEta(1, 30000)).toBe(0)
    expect(estimateEta(1.2, 30000)).toBe(0)
    expect(estimateEta(Number.NaN, 30000)).toBeNull()
    expect(estimateEta(0.5, Number.NaN)).toBeNull()
    expect(estimateEta(0.5, -1)).toBeNull()
  })

  test('formatEta rounds to minutes and handles < 1 min', () => {
    expect(formatEta(6 * 60000)).toBe('約剩 6 分')
    expect(formatEta(41 * 60000)).toBe('約剩 41 分')
    expect(formatEta(90000)).toBe('約剩 2 分') // 1.5 分四捨五入
    expect(formatEta(30000)).toBe('約剩 1 分')
    expect(formatEta(29999)).toBe('不到 1 分')
    expect(formatEta(0)).toBe('不到 1 分')
    expect(formatEta(-5)).toBe('不到 1 分')
    expect(formatEta(Number.NaN)).toBe('不到 1 分')
  })

  test('trackEta tracks analyzing start time per path and drops finished items', () => {
    const state = new Map<string, number>()
    const entry = { path: 'a.mp4', status: 'analyzing', progress: 0.5 }

    // 第一次看到：開始時間 = now；elapsed 0 → ETA 0（公式的極限值）
    let map = trackEta(state, [entry], 1000)
    expect(map.get('a.mp4')).toBe(0)
    expect(state.get('a.mp4')).toBe(1000)

    // 60 秒後、進度不變：ETA ≈ 60 秒
    map = trackEta(state, [entry], 61000)
    expect(map.get('a.mp4')).toBeCloseTo(60000)

    // 非 analyzing 的項目不追蹤，且狀態被清除
    map = trackEta(state, [{ ...entry, status: 'done' }], 62000)
    expect(map.has('a.mp4')).toBe(false)
    expect(state.has('a.mp4')).toBe(false)

    // pending 不列入（沒有進度可估）
    map = trackEta(state, [{ ...entry, status: 'pending' }], 63000)
    expect(map.size).toBe(0)
  })
})
