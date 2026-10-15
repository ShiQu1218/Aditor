import { describe, expect, test } from 'vitest'
import { sourceBadge } from './sourceColors'

describe('sourceColors', () => {
  test('sourceBadge is stable per source order and wraps after Z', () => {
    const sources = ['C:/a.mp4', 'C:/b.mp4', 'C:/c.mp4']

    expect(sourceBadge('C:/a.mp4', sources)).toEqual({ letter: 'A', colorVar: 'var(--src-1)' })
    expect(sourceBadge('C:/b.mp4', sources)).toEqual({ letter: 'B', colorVar: 'var(--src-2)' })
    expect(sourceBadge('C:/c.mp4', sources)).toEqual({ letter: 'C', colorVar: 'var(--src-3)' })

    // 穩定：同輸入 → 同輸出（不受呼叫順序影響）
    expect(sourceBadge('C:/b.mp4', sources)).toEqual(sourceBadge('C:/b.mp4', [...sources]))

    // 不在清單中的來源 → 退回第一格（不丟錯）
    expect(sourceBadge('C:/zzz.mp4', sources).letter).toBe('A')

    // 27 支來源：第 27 個（index 26）繞回 'A'
    const many = Array.from({ length: 27 }, (_, i) => `C:/v${i}.mp4`)
    expect(sourceBadge(many[0], many).letter).toBe('A')
    expect(sourceBadge(many[25], many).letter).toBe('Z')
    // 字母與色盤各自循環：index 26 → 字母繞回 'A'、色盤 26 % 6 = 2 → --src-3
    expect(sourceBadge(many[26], many)).toEqual({ letter: 'A', colorVar: 'var(--src-3)' })

    // 色盤 6 色循環（index 6 → 第 7 格 → --src-1）
    expect(sourceBadge(many[6], many)).toEqual({ letter: 'G', colorVar: 'var(--src-1)' })
    expect(sourceBadge(many[7], many)).toEqual({ letter: 'H', colorVar: 'var(--src-2)' })
  })
})
