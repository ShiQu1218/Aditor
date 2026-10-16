import { describe, expect, test } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
// @ts-expect-error 假引擎是純 .mjs，沒有型別宣告
import { resolveProfile, isCacheFresh, UNDETERMINED_VERSION } from '../../test/fake-engine-e2e.mjs'

const REPO_TEMPLATES = path.resolve(__dirname, '../../../templates')

describe('假引擎 resolveProfile：鏡像引擎的單一語言／auto 語言解析', () => {
  test('單一語言目錄（有 profile.json）→ 讀它的 lang／templates_version，非 auto', () => {
    const p = resolveProfile(path.join(REPO_TEMPLATES, 'en'), {})
    expect(p).toMatchObject({ auto: false, lang: 'en', detected: true })
    expect(p.templatesVersion).toMatch(/^en@/)
  })

  test('templates 根目錄（無 profile.json）＝auto：預設判成 zh-TW', () => {
    const p = resolveProfile(REPO_TEMPLATES, {})
    expect(p).toMatchObject({ auto: true, lang: 'zh-TW', detected: true })
  })

  test('auto 可由 FAKE_ENGINE_AUTO_LANG 指定語言（驅動 e2e 的 en／ja 情境）', () => {
    expect(resolveProfile(REPO_TEMPLATES, { FAKE_ENGINE_AUTO_LANG: 'ja' })).toMatchObject({ auto: true, lang: 'ja', detected: true })
  })

  test('auto 且 FAKE_ENGINE_AUTO_LANG=none → 無法判斷語言（lang null、detected false）', () => {
    expect(resolveProfile(REPO_TEMPLATES, { FAKE_ENGINE_AUTO_LANG: 'none' })).toMatchObject({
      auto: true,
      lang: null,
      detected: false,
      templatesVersion: UNDETERMINED_VERSION
    })
  })

  test('以 "auto" 資料夾名稱指向 templates 根目錄也是 auto', () => {
    expect(resolveProfile(path.join(REPO_TEMPLATES, 'auto'), {})).toMatchObject({ auto: true, detected: true })
  })

  test('沒有任何 profile（空字串）→ 退回 zh-TW 單一語言（舊行為）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-'))
    expect(resolveProfile(dir, {})).toMatchObject({ lang: 'zh-TW', detected: true })
    expect(resolveProfile('', {})).toMatchObject({ lang: 'zh-TW', detected: true })
  })
})

describe('假引擎 isCacheFresh：鏡像 cache.needs_reanalysis', () => {
  const info = { size: 10, mtime: 5 }
  const doc = (analysis: Record<string, unknown>, profile = 'zh-TW') => ({
    video: { size: 10, mtime: 5 },
    profile,
    analysis: { status: 'done', engine_version: '0.1.0', templates_version: 'zh-TW@1', profile, ...analysis }
  })
  const single = { auto: false, lang: 'zh-TW', detected: true, templatesVersion: 'zh-TW@1' }
  const auto = { auto: true, lang: 'zh-TW', detected: true, templatesVersion: 'zh-TW@1' }

  test('單一語言：版本需完全相同', () => {
    expect(isCacheFresh(doc({}), info, single)).toBe(true)
    expect(isCacheFresh(doc({ templates_version: 'en@2' }, 'en'), info, single)).toBe(false)
  })

  test('auto：任何已知語言的版本都算新；未知版本或 lang_detected=false 要重跑', () => {
    expect(isCacheFresh(doc({ templates_version: 'en@2' }, 'en'), info, auto)).toBe(true)
    expect(isCacheFresh(doc({ templates_version: 'xx@1' }, 'xx'), info, auto)).toBe(false)
    expect(isCacheFresh(doc({ templates_version: UNDETERMINED_VERSION, lang_detected: false }, ''), info, auto)).toBe(false)
  })

  test('檔案大小、狀態不符 → 重跑', () => {
    expect(isCacheFresh(doc({}), { size: 11, mtime: 5 }, single)).toBe(false)
    expect(isCacheFresh(doc({ status: 'partial' }), info, single)).toBe(false)
  })
})
