import { describe, expect, test } from 'vitest'
import { VIRTUALIZE_MIN, listWindow } from './listWindow'

describe('listWindow', () => {
  test('listWindow disabled below 200 items (returns full range)', () => {
    const full = listWindow({ count: VIRTUALIZE_MIN, rowHeight: 44, scrollTop: 4400, viewHeight: 440, overscan: 6 })
    expect(full).toEqual({ start: 0, end: VIRTUALIZE_MIN, padTop: 0, padBottom: 0 })

    const empty = listWindow({ count: 0, rowHeight: 44, scrollTop: 0, viewHeight: 440, overscan: 6 })
    expect(empty).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 })
  })

  test('listWindow returns padded window and clamps at ends', () => {
    const count = 1000
    const rowHeight = 44
    const viewHeight = 440
    const overscan = 6

    // 中段：first = 100，visible = 10
    const mid = listWindow({ count, rowHeight, scrollTop: rowHeight * 100, viewHeight, overscan })
    expect(mid.start).toBe(94)
    expect(mid.end).toBe(116)
    expect(mid.padTop).toBe(94 * rowHeight)
    expect(mid.padBottom).toBe((count - 116) * rowHeight)

    // 頂端：不可為負
    const top = listWindow({ count, rowHeight, scrollTop: 0, viewHeight, overscan })
    expect(top.start).toBe(0)
    expect(top.end).toBe(16)
    expect(top.padTop).toBe(0)

    // 負 scrollTop 也夾住
    const negative = listWindow({ count, rowHeight, scrollTop: -500, viewHeight, overscan })
    expect(negative.start).toBe(0)
    expect(negative.padTop).toBe(0)

    // 底端：end 不超過 count、padBottom 為 0
    const bottom = listWindow({
      count,
      rowHeight,
      scrollTop: count * rowHeight - viewHeight,
      viewHeight,
      overscan
    })
    expect(bottom.end).toBe(count)
    expect(bottom.padBottom).toBe(0)
    expect(bottom.start).toBe(984)
  })

  test('listWindow virtualizes as soon as count = 201 (VIRTUALIZE_MIN + 1)', () => {
    const w = listWindow({ count: VIRTUALIZE_MIN + 1, rowHeight: 44, scrollTop: 0, viewHeight: 440, overscan: 6 })
    expect(w.start).toBe(0)
    expect(w.end).toBe(16) // 10 可視 + 6 overscan
    expect(w.padTop).toBe(0)
    expect(w.padBottom).toBe((201 - 16) * 44)
    // 恰好 200 筆仍是完整範圍
    expect(listWindow({ count: VIRTUALIZE_MIN, rowHeight: 44, scrollTop: 0, viewHeight: 440, overscan: 6 }).end).toBe(200)
  })
})
