import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { CARD, cardGeomStyle, cardHeight, cardRowHeight, computeGrid, gridColumns } from './gridLayout'

const base = {
  cardMin: 280,
  gap: 16,
  rowHeight: 250,
  headerHeight: 44,
  overscanRows: 2
}

describe('computeGrid', () => {
  test('computeGrid columns = floor((width+gap)/(cardMin+gap)) and never < 1', () => {
    expect(gridColumns(1920, 280, 16)).toBe(6) // floor(1936 / 296)
    expect(gridColumns(1200, 280, 16)).toBe(4) // floor(1216 / 296)
    expect(gridColumns(296, 280, 16)).toBe(1)
    expect(gridColumns(280, 280, 16)).toBe(1)
    expect(gridColumns(100, 280, 16)).toBe(1)
  })

  test('computeGrid returns only visible rows plus overscan for 500 entries', () => {
    const groups = [200, 300]
    const cols = gridColumns(1200, 280, 16) // 4
    const totalRows = groups.reduce((n, g) => n + 1 + Math.ceil(g / cols), 0)
    const group0Height = base.headerHeight + Math.ceil(200 / cols) * base.rowHeight // 12544

    const res = computeGrid({ ...base, width: 1200, groups, scrollTop: 1000, viewHeight: 600 })

    // 只渲染可視列＋上下 overscan，遠少於全部
    expect(res.rows.length).toBeGreaterThan(0)
    expect(res.rows.length).toBeLessThan(totalRows / 2)
    // 第一組的表頭已捲出畫面（不含在渲染列中），第二組尚未進入
    expect(res.rows.some((r) => r.type === 'header' && r.group === 0)).toBe(false)
    expect(res.rows.some((r) => r.group === 1)).toBe(false)
    // 可視範圍回報第 0 組
    expect(res.visible[0]).toBe(0)
    expect(res.visible[1]).toBe(0)

    // 捲到第二組的表頭附近時，表頭與其列出現（前一組尾列仍在 overscan 內，順序照檔案順序）
    const res2 = computeGrid({ ...base, width: 1200, groups, scrollTop: group0Height + 10, viewHeight: 300 })
    expect(res2.rows.some((r) => r.type === 'header' && r.group === 1)).toBe(true)
    expect(res2.rows.some((r) => r.type === 'row' && r.group === 1 && r.from === 0)).toBe(true)
    expect(res2.visible).toEqual([1, 1])
  })

  test('computeGrid total height equals sum of header and row heights', () => {
    const groups = [5, 0, 9]
    const cols = gridColumns(1200, 280, 16) // 4
    const res = computeGrid({ ...base, width: 1200, groups, scrollTop: 0, viewHeight: 800 })
    const expected = groups.length * base.headerHeight + (Math.ceil(5 / cols) + 0 + Math.ceil(9 / cols)) * base.rowHeight
    expect(res.totalHeight).toBe(expected)
    expect(res.offsets).toEqual([0, base.headerHeight + Math.ceil(5 / cols) * base.rowHeight, base.headerHeight * 2 + Math.ceil(5 / cols) * base.rowHeight])
  })

  test('computeGrid row ranges clamp from/to to the group size', () => {
    const res = computeGrid({ ...base, width: 1200, groups: [6], scrollTop: 0, viewHeight: 800 })
    const row = res.rows.find((r) => r.type === 'row')
    expect(row).toEqual({ type: 'row', group: 0, from: 0, to: 3 }) // 一列 4 張
    const last = res.rows.filter((r) => r.type === 'row').pop()
    expect(last).toEqual({ type: 'row', group: 0, from: 4, to: 5 }) // 尾列不足 4 張
  })

  test('computeGrid clamps scroll beyond the end and handles empty groups', () => {
    const groups = [8]
    const cols = gridColumns(1200, 280, 16)
    const total = base.headerHeight + Math.ceil(8 / cols) * base.rowHeight

    // 捲動位置被夾在內容尾端：仍渲染最後一列，不會空白
    const beyond = computeGrid({ ...base, width: 1200, groups, scrollTop: total + 200, viewHeight: 400 })
    const lastRow = beyond.rows.filter((r) => r.type === 'row').pop()
    expect(lastRow).toEqual({ type: 'row', group: 0, from: 4, to: 7 })
    expect(beyond.visible).toEqual([0, 0])

    const empty = computeGrid({ ...base, width: 1200, groups: [], scrollTop: 0, viewHeight: 400 })
    expect(empty.rows).toEqual([])
    expect(empty.totalHeight).toBe(0)
    expect(empty.visible).toEqual([0, -1])
  })

  test('perf: computeGrid with 500 entries < 2ms', () => {
    const groups = Array.from({ length: 50 }, () => 10)
    const times: number[] = []
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now()
      computeGrid({ ...base, width: 1600, groups, scrollTop: i * 240, viewHeight: 900 })
      times.push(performance.now() - t0)
    }
    times.sort((a, b) => a - b)
    const median = times[Math.floor(times.length / 2)]
    expect(median).toBeLessThan(2)
  })
})

describe('card geometry (single source of truth)', () => {
  test('cardRowHeight = border + 16:9 thumb of inner width + body + gap', () => {
    const w = 296
    expect(cardHeight(w)).toBe(Math.round(((w - 2 * CARD.border) * 9) / 16) + 2 * CARD.border + CARD.bodyH)
    expect(cardRowHeight(w)).toBe(cardHeight(w) + CARD.gap)
  })
  test('CARD.min equals --card-min in tokens.css; library.css has no hard-coded body height', () => {
    const tokens = readFileSync(resolve(__dirname, '../styles/tokens.css'), 'utf8')
    expect(Number(/--card-min:\s*(\d+)px/.exec(tokens)?.[1])).toBe(CARD.min)
    const css = readFileSync(resolve(__dirname, '../styles/library.css'), 'utf8')
    expect(css).toMatch(/\.vcard-body\s*\{[^}]*height:\s*var\(--card-body-h\)/)
    expect(cardGeomStyle()).toMatchObject({ '--card-body-h': `${CARD.bodyH}px`, '--card-gap': `${CARD.gap}px` })
  })
  test('error card content fits the body (name + reason + 26px actions)', () => {
    // 10 上內距 + 名稱 20 + 4 + 原因 18 + 6 + 按鈕 26 + 10 下內距
    expect(CARD.bodyH).toBeGreaterThanOrEqual(10 + 20 + 4 + 18 + 6 + 26 + 10)
  })
})
