import { describe, expect, test } from 'vitest'
import fs from 'fs'
import path from 'path'
import { SETTING_ROWS, CATEGORIES, type SettingRow } from './rows'
import { filterRows } from './filterRows'
import { settingsI18n, recordingI18n } from '../i18n'

const mk = (over: Partial<SettingRow> & { id: string }): SettingRow => ({
  category: 'general',
  card: '卡片',
  title: '標題',
  control: { kind: 'none' },
  ...over
})

describe('SETTING_ROWS (data table)', () => {
  test('every category has rows and a one-line description', () => {
    for (const c of CATEGORIES) {
      expect(SETTING_ROWS.filter((r) => r.category === c.id).length, c.id).toBeGreaterThanOrEqual(2)
      expect(c.desc.length, c.id).toBeGreaterThan(0)
    }
  })

  test('categories are ordered by what the user wants to do', () => {
    expect(CATEGORIES.map((c) => c.label)).toEqual(['一般', '錄影', '匯入與分析', '剪輯', '匯出', '關於'])
  })

  test('Every recording setting appears exactly once; app-wide settings belong under General', () => {
    const ids = SETTING_ROWS.filter((r) => r.control.kind === 'recording').map((r) => r.id)
    expect([...ids].sort()).toEqual(Object.keys(recordingI18n.rows).map((f) => `recording-${f}`).sort())
    for (const id of ['recording-launchAtLogin', 'recording-closeToTray']) {
      expect(SETTING_ROWS.find((r) => r.id === id)!.category).toBe('general')
    }
  })

  test('rows of the same card are contiguous (a card never splits)', () => {
    const seen = new Set<string>()
    let prev = ''
    for (const r of SETTING_ROWS) {
      const key = `${r.category}:${r.card}`
      if (key !== prev) expect(seen.has(key), key).toBe(false)
      seen.add(key)
      prev = key
    }
  })

  test('row ids are unique and every row has a title', () => {
    const ids = SETTING_ROWS.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const r of SETTING_ROWS) expect(r.title.length).toBeGreaterThan(0)
  })

  test('No row text contains “IPC needs to be added” (rows.ts, i18n, and every row)', () => {
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
    mk({ id: 'r1', category: 'analysis', card: '影片來源', title: '監看資料夾', desc: '新影片自動匯入', keywords: ['Watch'] }),
    mk({ id: 'r2', category: 'analysis', card: '分析', title: '解碼方式' }),
    mk({ id: 'r3', category: 'editing', card: '代理檔', title: '建議代理檔', desc: 'mediaCapabilities' }),
    mk({ id: 'r4', category: 'export', card: '匯出', title: '編碼器', keywords: ['NVENC'] })
  ]

  test('empty query returns all rows grouped by category', () => {
    for (const q of ['', '   ']) {
      const res = filterRows(rows, q)
      expect(res.byCategory.analysis.map((r) => r.id)).toEqual(['r1', 'r2'])
      expect(res.byCategory.editing.map((r) => r.id)).toEqual(['r3'])
      expect(res.byCategory.export.map((r) => r.id)).toEqual(['r4'])
      expect(res.counts).toEqual({ analysis: 2, editing: 1, export: 1 })
    }
  })

  test('filterRows is case-insensitive and matches title, desc, keywords and card name', () => {
    expect(filterRows(rows, 'WATCH').byCategory.analysis.map((r) => r.id)).toEqual(['r1']) // Keyword, different case.
    expect(filterRows(rows, 'nvenc').byCategory.export.map((r) => r.id)).toEqual(['r4'])
    expect(filterRows(rows, 'MEDIACAPABILITIES').byCategory.editing.map((r) => r.id)).toEqual(['r3']) // desc
    expect(filterRows(rows, '解碼').byCategory.analysis.map((r) => r.id)).toEqual(['r2']) // Title.
    expect(filterRows(rows, '影片來源').byCategory.analysis.map((r) => r.id)).toEqual(['r1']) // Card name.
  })

  test('counts only include categories with hits', () => {
    const res = filterRows(rows, '代理檔')
    expect(res.counts).toEqual({ editing: 1 })
    expect('analysis' in res.counts).toBe(false)
    expect(res.byCategory.analysis).toEqual([])
    expect(res.byCategory.export).toEqual([])
  })

  test('multiple words must all match (any field)', () => {
    expect(filterRows(rows, '資料夾 watch').counts).toEqual({ analysis: 1 })
    expect(filterRows(rows, '資料夾 nvenc').counts).toEqual({})
  })

  test('no match gives empty groups and empty counts', () => {
    const res = filterRows(rows, 'zzzz')
    expect(res.counts).toEqual({})
    expect(res.byCategory).toEqual({ general: [], recording: [], analysis: [], editing: [], export: [], about: [] })
  })

  test('real rows: searching finds rows across categories', () => {
    expect(Object.keys(filterRows(SETTING_ROWS, '錄影').counts).sort()).toEqual(['general', 'recording'])
    expect(Object.keys(filterRows(SETTING_ROWS, '資料夾').counts)).toEqual(['general', 'analysis'])
  })
})
