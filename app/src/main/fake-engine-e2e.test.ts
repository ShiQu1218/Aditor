import { describe, expect, test } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
// @ts-expect-error 假引擎是純 .mjs，沒有型別宣告
import { resolveProfile, isCacheFresh } from '../../test/fake-engine-e2e.mjs'

const ICONS_DIR = path.resolve(__dirname, '../../../templates/icons')

describe('假引擎 resolveProfile：鏡像引擎的單一（與語言無關）設定檔', () => {
  test('templates/icons 的 profile.json → 讀它的 templates_version', () => {
    const p = resolveProfile(ICONS_DIR)
    expect(p.templatesVersion).toMatch(/^icons@/)
    expect(Object.keys(p)).toEqual(['templatesVersion'])
  })

  test('沒有 profile.json（或空字串）→ 預設 icons@1', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-'))
    expect(resolveProfile(dir).templatesVersion).toBe('icons@1')
    expect(resolveProfile('').templatesVersion).toBe('icons@1')
  })
})

describe('假引擎 isCacheFresh：鏡像 cache.needs_reanalysis', () => {
  const info = { size: 10, mtime: 5 }
  const doc = (analysis: Record<string, unknown>) => ({
    video: { size: 10, mtime: 5 },
    analysis: { status: 'done', engine_version: '0.1.0', templates_version: 'icons@1', ...analysis }
  })
  const prof = { templatesVersion: 'icons@1' }

  test('樣板版本需完全相同（舊語言樣板版本的快取要重跑）', () => {
    expect(isCacheFresh(doc({}), info, prof)).toBe(true)
    expect(isCacheFresh(doc({ templates_version: 'en@2' }), info, prof)).toBe(false)
    expect(isCacheFresh(doc({ templates_version: 'zh-TW@3' }), info, prof)).toBe(false)
  })

  test('檔案大小、狀態不符 → 重跑', () => {
    expect(isCacheFresh(doc({}), { size: 11, mtime: 5 }, prof)).toBe(false)
    expect(isCacheFresh(doc({ status: 'partial' }), info, prof)).toBe(false)
  })
})
