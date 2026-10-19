import { describe, expect, test } from 'vitest'
import fs from 'fs'
import path from 'path'
import { SETTING_ROWS, CATEGORIES, type SettingRow } from './rows'
import { filterRows } from './filterRows'
import { settingsI18n } from '../i18n/zh-TW'

const mk = (over: Partial<SettingRow> & { id: string }): SettingRow => ({
  category: 'a',
  card: '卡片',
  title: '標題',
  control: { kind: 'none' },
  ...over
})

describe('SETTING_ROWS（資料表）', () => {
  test('every category has at least 4 rows', () => {
    for (const c of CATEGORIES) {
      expect(SETTING_ROWS.filter((r) => r.category === c.id).length, c.id).toBeGreaterThanOrEqual(4)
    }
  })

  test('categories include recording alongside the existing categories', () => {
    expect(CATEGORIES.map((c) => c.label)).toEqual(['影片與分析', '預覽與剪輯', '匯出與關於', '錄影'])
  })

  test('row ids are unique and every row has a title', () => {
    const ids = SETTING_ROWS.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const r of SETTING_ROWS) expect(r.title.length).toBeGreaterThan(0)
  })

  test('no row text contains 需新增 IPC (rows.ts, i18n and every row)', () => {
    const banned = '需新增 IPC'
    for (const r of SETTING_ROWS) {
      const text = [r.title, r.desc, r.card, r.disabledReason, ...(r.keywords ?? [])].join('|')
      expect(text).not.toContain(banned)
    }
    expect(JSON.stringify(settingsI18n)).not.toContain(banned)
    for (const f of ['rows.ts', '../i18n/zh-TW.ts']) {
      expect(fs.readFileSync(path.join(__dirname, f), 'utf-8')).not.toContain(banned)
    }
  })

  test('any row that is disabled carries a non-empty explanation (OpenH264 is no longer disabled)', () => {
    expect(SETTING_ROWS.find((r) => r.id === 'openh264')!.disabledReason).toBeUndefined()
    for (const r of SETTING_ROWS.filter((r) => r.disabledReason)) expect(r.disabledReason!.length).toBeGreaterThan(0)
  })
})

describe('filterRows', () => {
  const rows = [
    mk({ id: 'r1', category: 'a', card: '影片來源', title: '監看資料夾', desc: '新影片自動匯入', keywords: ['Watch'] }),
    mk({ id: 'r2', category: 'a', card: '分析', title: '解碼方式' }),
    mk({ id: 'r3', category: 'b', card: '代理檔', title: '建議代理檔', desc: 'mediaCapabilities' }),
    mk({ id: 'r4', category: 'c', card: '匯出', title: '編碼器', keywords: ['NVENC'] })
  ]

  test('empty query returns all rows grouped by category', () => {
    for (const q of ['', '   ']) {
      const res = filterRows(rows, q)
      expect(res.byCategory.a.map((r) => r.id)).toEqual(['r1', 'r2'])
      expect(res.byCategory.b.map((r) => r.id)).toEqual(['r3'])
      expect(res.byCategory.c.map((r) => r.id)).toEqual(['r4'])
      expect(res.counts).toEqual({ a: 2, b: 1, c: 1 })
    }
  })

  test('filterRows is case-insensitive and matches title, desc, keywords and card name', () => {
    expect(filterRows(rows, 'WATCH').byCategory.a.map((r) => r.id)).toEqual(['r1']) // keyword，大小寫不同
    expect(filterRows(rows, 'nvenc').byCategory.c.map((r) => r.id)).toEqual(['r4'])
    expect(filterRows(rows, 'MEDIACAPABILITIES').byCategory.b.map((r) => r.id)).toEqual(['r3']) // desc
    expect(filterRows(rows, '解碼').byCategory.a.map((r) => r.id)).toEqual(['r2']) // title
    expect(filterRows(rows, '影片來源').byCategory.a.map((r) => r.id)).toEqual(['r1']) // card 名
  })

  test('counts only include categories with hits', () => {
    const res = filterRows(rows, '代理檔')
    expect(res.counts).toEqual({ b: 1 })
    expect('a' in res.counts).toBe(false)
    expect(res.byCategory.a).toEqual([])
    expect(res.byCategory.c).toEqual([])
  })

  test('multiple words must all match (any field)', () => {
    expect(filterRows(rows, '資料夾 watch').counts).toEqual({ a: 1 })
    expect(filterRows(rows, '資料夾 nvenc').counts).toEqual({})
  })

  test('no match gives empty groups and empty counts', () => {
    const res = filterRows(rows, 'zzzz')
    expect(res.counts).toEqual({})
    expect(res.byCategory).toEqual({ a: [], b: [], c: [], recording: [] })
  })

  test('real rows: searching finds rows across categories', () => {
    const res = filterRows(SETTING_ROWS, '資料夾')
    expect(Object.keys(res.counts).sort()).toEqual(['a', 'c', 'recording'])
  })
})
