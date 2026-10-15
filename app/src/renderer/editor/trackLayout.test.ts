import { describe, expect, test } from 'vitest'
import { dropIndex, itemWidth, trimFromDrag } from './trackLayout'

describe('trackLayout', () => {
  test('itemWidth clamps to [92,360] at 6px/s', () => {
    expect(itemWidth(5)).toBe(92) // 30px → 最小 92
    expect(itemWidth(10)).toBe(92) // 60px → 最小 92
    expect(itemWidth(20)).toBe(120) // 6px/秒
    expect(itemWidth(60)).toBe(360) // 上限 360
    expect(itemWidth(120)).toBe(360)
    expect(itemWidth(0)).toBe(92)
  })

  test('dropIndex picks insertion index by midpoint', () => {
    const xs = [0, 100, 200]
    const widths = [100, 100, 100]
    expect(dropIndex(xs, widths, -50)).toBe(0) // 最左 → 插到最前
    expect(dropIndex(xs, widths, 40)).toBe(0) // 卡 0 中點（50）左側
    expect(dropIndex(xs, widths, 60)).toBe(1) // 卡 0 中點右側 → 卡 0 與卡 1 之間
    expect(dropIndex(xs, widths, 150)).toBe(2) // 卡 1 中點右側 → 卡 1 與卡 2 之間
    expect(dropIndex(xs, widths, 260)).toBe(3) // 最後一張中點右側 → 插到最後
    expect(dropIndex([], [], 10)).toBe(0)
  })

  test('trimFromDrag respects min length 1s and video bounds', () => {
    const item = { start: 10, end: 20 }

    // 起點往右拖超過終點 → 夾在 end - 1（最短 1 秒）
    expect(trimFromDrag(item, 'start', 100 * 6, 6, 30)).toEqual({ start: 19, end: 20 })
    // 起點往左拖出片頭 → 夾在 0
    expect(trimFromDrag(item, 'start', -100 * 6, 6, 30)).toEqual({ start: 0, end: 20 })
    // 終點往左拖超過起點 → 夾在 start + 1（最短 1 秒）
    expect(trimFromDrag(item, 'end', -100 * 6, 6, 30)).toEqual({ start: 10, end: 11 })
    // 終點往右拖超出影片長度 → 夾在 duration
    expect(trimFromDrag(item, 'end', 100 * 6, 6, 30)).toEqual({ start: 10, end: 30 })

    // 小幅度拖曳：dx / pxPerSec 即秒數差（12px ÷ 6px/s = +2s）
    expect(trimFromDrag(item, 'end', 12, 6, 30)).toEqual({ start: 10, end: 22 })
    expect(trimFromDrag(item, 'start', -6, 6, 30)).toEqual({ start: 9, end: 20 })

    // 不修改來源物件
    expect(item).toEqual({ start: 10, end: 20 })
  })
})
