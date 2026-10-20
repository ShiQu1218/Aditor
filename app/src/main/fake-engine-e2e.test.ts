import { describe, expect, test } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
// @ts-expect-error The fake engine is plain .mjs and has no type declarations.
import { resolveProfile, isCacheFresh } from '../../test/fake-engine-e2e.mjs'

const ICONS_DIR = path.resolve(__dirname, '../../../templates/icons')

describe('fake engine resolveProfile: mirrors the engine single (language-independent) profile', () => {
  test('reads templates_version from templates/icons/profile.json', () => {
    const p = resolveProfile(ICONS_DIR)
    expect(p.templatesVersion).toMatch(/^icons@/)
    expect(Object.keys(p)).toEqual(['templatesVersion'])
  })

  test('defaults to icons@1 when profile.json is missing or empty', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-'))
    expect(resolveProfile(dir).templatesVersion).toBe('icons@1')
    expect(resolveProfile('').templatesVersion).toBe('icons@1')
  })
})

describe('fake engine isCacheFresh: mirrors cache.needs_reanalysis', () => {
  const info = { size: 10, mtime: 5 }
  const doc = (analysis: Record<string, unknown>) => ({
    video: { size: 10, mtime: 5 },
    analysis: { status: 'done', engine_version: '0.1.0', templates_version: 'icons@1', ...analysis }
  })
  const prof = { templatesVersion: 'icons@1' }

  test('template versions must match exactly (rerun caches made with an older language template version)', () => {
    expect(isCacheFresh(doc({}), info, prof)).toBe(true)
    expect(isCacheFresh(doc({ templates_version: 'en@2' }), info, prof)).toBe(false)
    expect(isCacheFresh(doc({ templates_version: 'zh-TW@3' }), info, prof)).toBe(false)
  })

  test('reruns when file size or status does not match', () => {
    expect(isCacheFresh(doc({}), { size: 11, mtime: 5 }, prof)).toBe(false)
    expect(isCacheFresh(doc({ status: 'partial' }), info, prof)).toBe(false)
  })
})
