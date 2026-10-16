import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { cacheFilePath, resolveCacheFile } from './cache-io'
import { analyzeSettingArgs, buildAnalyzeArgs, resolveAnalyzeProfileDir } from './settings-derived'
import { DEFAULT_SETTINGS } from '../shared/settings'

describe('cacheFilePath：與引擎 cache_path(video, cache_dir, beside) 同一規則', () => {
  it('appdata：sha1(正規化路徑).json 位於快取資料夾', () => {
    const p = cacheFilePath('D:/Videos/A.mp4', 'C:/cache')
    expect(path.dirname(p)).toBe(path.normalize('C:/cache'))
    expect(path.basename(p)).toMatch(/^[0-9a-f]{40}\.json$/)
  })

  it('beside：<影片資料夾>/<主檔名>.apexhl.json（多重點號只去掉最後副檔名）', () => {
    expect(cacheFilePath('D:/Videos/Apex.2026.mp4', 'C:/cache', true)).toBe(
      path.join('D:/Videos', 'Apex.2026.apexhl.json')
    )
    expect(cacheFilePath('D:/Videos/a.mp4', 'C:/cache', true)).toBe(path.join('D:/Videos', 'a.apexhl.json'))
  })
})

describe('resolveCacheFile：切換設定後舊快取仍可讀取', () => {
  let dir: string
  let video: string
  let cdir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apexhl-cl-'))
    cdir = path.join(dir, 'cache')
    fs.mkdirSync(cdir)
    video = path.join(dir, 'v.mp4')
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('偏好位置有檔 → 用偏好位置', () => {
    fs.writeFileSync(cacheFilePath(video, cdir, true), '{}')
    fs.writeFileSync(cacheFilePath(video, cdir, false), '{}')
    expect(resolveCacheFile(video, cdir, true)).toBe(cacheFilePath(video, cdir, true))
    expect(resolveCacheFile(video, cdir, false)).toBe(cacheFilePath(video, cdir, false))
  })

  it('偏好位置沒有、另一位置有 → 退到另一位置', () => {
    fs.writeFileSync(cacheFilePath(video, cdir, false), '{}')
    expect(resolveCacheFile(video, cdir, true)).toBe(cacheFilePath(video, cdir, false))
    fs.rmSync(cacheFilePath(video, cdir, false))
    fs.writeFileSync(cacheFilePath(video, cdir, true), '{}')
    expect(resolveCacheFile(video, cdir, false)).toBe(cacheFilePath(video, cdir, true))
  })

  it('兩處都沒有 → 偏好位置', () => {
    expect(resolveCacheFile(video, cdir, true)).toBe(cacheFilePath(video, cdir, true))
    expect(resolveCacheFile(video, cdir, false)).toBe(cacheFilePath(video, cdir, false))
  })
})

describe('analyzeSettingArgs：decode／cacheLocation → 引擎參數', () => {
  it('auto/appdata → hwaccel true、beside false', () => {
    expect(analyzeSettingArgs({ ...DEFAULT_SETTINGS })).toEqual({ hwaccel: true, beside: false })
  })
  it("software → hwaccel false；besideVideo → beside true", () => {
    expect(analyzeSettingArgs({ ...DEFAULT_SETTINGS, decode: 'software', cacheLocation: 'besideVideo' })).toEqual({
      hwaccel: false,
      beside: true
    })
  })
  it('沒有設定來源（尚未初始化）→ 預設值', () => {
    expect(analyzeSettingArgs(undefined)).toEqual({ hwaccel: true, beside: false })
  })
  it('buildAnalyzeArgs：設定值覆蓋 renderer 傳來的同名欄位，其餘保留', () => {
    const out = buildAnalyzeArgs(
      { profile_dir: 'p', cache_dir: 'c' },
      { ...DEFAULT_SETTINGS, decode: 'software' },
      { path: 'D:/v.mp4', hwaccel: true, beside: 'yes' }
    )
    expect(out).toEqual({ profile_dir: 'p', cache_dir: 'c', path: 'D:/v.mp4', hwaccel: false, beside: false })
  })
})

describe('resolveAnalyzeProfileDir：gameLang → 引擎 profile_dir', () => {
  const root = path.join('X', 'templates')
  const withLang = (gameLang: 'auto' | 'zh-TW' | 'en' | 'ja') => ({ ...DEFAULT_SETTINGS, gameLang })

  it('沒有設定來源或沒有 gameLang → 原樣（舊行為）', () => {
    expect(resolveAnalyzeProfileDir(root, undefined)).toBe(root)
    expect(resolveAnalyzeProfileDir(root, { decode: 'auto', cacheLocation: 'appdata' })).toBe(root)
  })
  it('auto → templates 根目錄（引擎自動偵測語言）', () => {
    expect(resolveAnalyzeProfileDir(root, withLang('auto'))).toBe(root)
  })
  it('指定語言 → templates/<語言>', () => {
    expect(resolveAnalyzeProfileDir(root, withLang('en'))).toBe(path.join(root, 'en'))
    expect(resolveAnalyzeProfileDir(root, withLang('ja'))).toBe(path.join(root, 'ja'))
    expect(resolveAnalyzeProfileDir(root, withLang('zh-TW'))).toBe(path.join(root, 'zh-TW'))
  })
  it('基準目錄本身已是某個語言資料夾 → 先回到 templates 根目錄再換語言', () => {
    expect(resolveAnalyzeProfileDir(path.join(root, 'zh-TW'), withLang('ja'))).toBe(path.join(root, 'ja'))
    expect(resolveAnalyzeProfileDir(path.join(root, 'en'), withLang('auto'))).toBe(root)
    expect(resolveAnalyzeProfileDir(path.join(root, 'auto'), withLang('en'))).toBe(path.join(root, 'en'))
  })
  it('基準目錄名稱不是語言（任意資料夾名）→ 視為 templates 根目錄', () => {
    const custom = path.join('X', 'my-profiles')
    expect(resolveAnalyzeProfileDir(custom, withLang('ja'))).toBe(path.join(custom, 'ja'))
    expect(resolveAnalyzeProfileDir(custom, withLang('auto'))).toBe(custom)
  })
  it('buildAnalyzeArgs 的 profile_dir 依 gameLang 轉換，renderer 傳來的同名欄位仍被覆蓋順序保留', () => {
    const out = buildAnalyzeArgs({ profile_dir: root, cache_dir: 'c' }, withLang('en'), { path: 'D:/v.mp4' })
    expect(out.profile_dir).toBe(path.join(root, 'en'))
    expect(out.path).toBe('D:/v.mp4')
  })
  it('buildAnalyzeArgs：renderer 傳來的 profile_dir 不得蓋過設定（profile_dir 一律由主程序依 gameLang 決定）', () => {
    const out = buildAnalyzeArgs({ profile_dir: root, cache_dir: 'c' }, withLang('ja'), { profile_dir: 'EVIL', path: 'D:/v.mp4' })
    expect(out.profile_dir).toBe(path.join(root, 'ja'))
  })
})
