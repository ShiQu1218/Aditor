import { describe, expect, test } from 'vitest'
import { sourceBadge } from './sourceColors'

describe('sourceColors', () => {
  test('sourceBadge is stable per source order and wraps after Z', () => {
    const sources = ['C:/a.mp4', 'C:/b.mp4', 'C:/c.mp4']

    expect(sourceBadge('C:/a.mp4', sources)).toEqual({ letter: 'A', colorVar: 'var(--src-1)' })
    expect(sourceBadge('C:/b.mp4', sources)).toEqual({ letter: 'B', colorVar: 'var(--src-2)' })
    expect(sourceBadge('C:/c.mp4', sources)).toEqual({ letter: 'C', colorVar: 'var(--src-3)' })

    // Stable mapping: the same input always produces the same output, regardless of call order.
    expect(sourceBadge('C:/b.mp4', sources)).toEqual(sourceBadge('C:/b.mp4', [...sources]))

    // A source missing from the list falls back to the first slot without throwing.
    expect(sourceBadge('C:/zzz.mp4', sources).letter).toBe('A')

    // With 27 sources, the 27th (index 26) wraps back to 'A'.
    const many = Array.from({ length: 27 }, (_, i) => `C:/v${i}.mp4`)
    expect(sourceBadge(many[0], many).letter).toBe('A')
    expect(sourceBadge(many[25], many).letter).toBe('Z')
    // Letters and colors cycle independently: index 26 wraps to 'A', while 26 % 6 = 2 maps to --src-3.
    expect(sourceBadge(many[26], many)).toEqual({ letter: 'A', colorVar: 'var(--src-3)' })

    // The six-color palette cycles: index 6 (the seventh slot) maps to --src-1.
    expect(sourceBadge(many[6], many)).toEqual({ letter: 'G', colorVar: 'var(--src-1)' })
    expect(sourceBadge(many[7], many)).toEqual({ letter: 'H', colorVar: 'var(--src-2)' })
  })
})
