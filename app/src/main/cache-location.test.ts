import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { cacheFilePath, legacyCacheFilePath, resolveCacheFile } from './cache-io'
import { analyzeSettingArgs, buildAnalyzeArgs } from './settings-derived'
import { DEFAULT_SETTINGS } from '../shared/settings'

describe('cacheFilePath: same rule as engine cache_path(video, cache_dir, beside)', () => {
  it('appdata: sha1(normalized path).json is in the cache directory', () => {
    const p = cacheFilePath('D:/Videos/A.mp4', 'C:/cache')
    expect(path.dirname(p)).toBe(path.normalize('C:/cache'))
    expect(path.basename(p)).toMatch(/^[0-9a-f]{40}\.json$/)
  })

  it('beside: keeps the complete filename so same-stem containers do not collide', () => {
    expect(cacheFilePath('D:/Videos/Apex.2026.mp4', 'C:/cache', true)).toBe(
      path.join('D:/Videos', 'Apex.2026.mp4.aditor.json')
    )
    expect(cacheFilePath('D:/Videos/a.mp4', 'C:/cache', true)).toBe(path.join('D:/Videos', 'a.mp4.aditor.json'))
    expect(cacheFilePath('D:/Videos/a.mkv', 'C:/cache', true)).not.toBe(cacheFilePath('D:/Videos/a.mp4', 'C:/cache', true))
    expect(legacyCacheFilePath('D:/Videos/a.mp4', 'C:/cache', true)).toBe(path.join('D:/Videos', 'a.aditor.json'))
  })
})

describe('resolveCacheFile: old caches remain readable after changing the setting', () => {
  let dir: string
  let video: string
  let cdir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-cl-'))
    cdir = path.join(dir, 'cache')
    fs.mkdirSync(cdir)
    video = path.join(dir, 'v.mp4')
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('uses the preferred location when its file exists', () => {
    fs.writeFileSync(cacheFilePath(video, cdir, true), '{}')
    fs.writeFileSync(cacheFilePath(video, cdir, false), '{}')
    expect(resolveCacheFile(video, cdir, true)).toBe(cacheFilePath(video, cdir, true))
    expect(resolveCacheFile(video, cdir, false)).toBe(cacheFilePath(video, cdir, false))
  })

  it('falls back to the other location when the preferred file is missing', () => {
    fs.writeFileSync(cacheFilePath(video, cdir, false), '{}')
    expect(resolveCacheFile(video, cdir, true)).toBe(cacheFilePath(video, cdir, false))
    fs.rmSync(cacheFilePath(video, cdir, false))
    fs.writeFileSync(cacheFilePath(video, cdir, true), '{}')
    expect(resolveCacheFile(video, cdir, false)).toBe(cacheFilePath(video, cdir, true))
  })

  it('uses the preferred location when neither file exists', () => {
    expect(resolveCacheFile(video, cdir, true)).toBe(cacheFilePath(video, cdir, true))
    expect(resolveCacheFile(video, cdir, false)).toBe(cacheFilePath(video, cdir, false))
  })

  it('accepts a legacy beside cache only when its video path matches', () => {
    const legacy = legacyCacheFilePath(video, cdir, true)
    const appdata = cacheFilePath(video, cdir, false)
    fs.writeFileSync(legacy, JSON.stringify({ video: { path: path.join(dir, 'other.mp4') } }))
    fs.writeFileSync(appdata, JSON.stringify({ where: 'appdata' }))
    expect(resolveCacheFile(video, cdir, true)).toBe(appdata)

    fs.rmSync(appdata)
    fs.writeFileSync(legacy, JSON.stringify({ video: { path: video }, where: 'legacy' }))
    expect(resolveCacheFile(video, cdir, true)).toBe(legacy)
  })

  it('when both valid locations exist, uses the newest edited copy and keeps preferred on a tie', () => {
    const beside = cacheFilePath(video, cdir, true)
    const appdata = cacheFilePath(video, cdir, false)
    const write = (p: string, where: string): void => fs.writeFileSync(p, JSON.stringify({ video: { path: video }, where }))
    write(appdata, 'appdata')
    write(beside, 'beside')
    fs.utimesSync(appdata, new Date(1000), new Date(1000))
    fs.utimesSync(beside, new Date(2000), new Date(2000))
    expect(resolveCacheFile(video, cdir, false)).toBe(beside)

    fs.utimesSync(appdata, new Date(3000), new Date(3000))
    expect(resolveCacheFile(video, cdir, true)).toBe(appdata)

    fs.utimesSync(appdata, new Date(4000), new Date(4000))
    fs.utimesSync(beside, new Date(4000), new Date(4000))
    expect(resolveCacheFile(video, cdir, false)).toBe(appdata)
    expect(resolveCacheFile(video, cdir, true)).toBe(beside)
  })

  it('does not let a corrupt preferred file hide a valid cache for the same video', () => {
    const appdata = cacheFilePath(video, cdir, false)
    const beside = cacheFilePath(video, cdir, true)
    fs.writeFileSync(appdata, '{broken', 'utf-8')
    fs.writeFileSync(beside, JSON.stringify({ video: { path: video }, where: 'beside' }))
    expect(resolveCacheFile(video, cdir, false)).toBe(beside)
  })
})

describe('analyzeSettingArgs: decode/cacheLocation → engine arguments', () => {
  it('auto/appdata → hwaccel true、beside false', () => {
    expect(analyzeSettingArgs({ ...DEFAULT_SETTINGS })).toEqual({ hwaccel: true, beside: false })
  })
  it("software → hwaccel false；besideVideo → beside true", () => {
    expect(analyzeSettingArgs({ ...DEFAULT_SETTINGS, decode: 'software', cacheLocation: 'besideVideo' })).toEqual({
      hwaccel: false,
      beside: true
    })
  })
  it('uses defaults when settings are unavailable (not initialized yet)', () => {
    expect(analyzeSettingArgs(undefined)).toEqual({ hwaccel: true, beside: false })
  })
  it('buildAnalyzeArgs: settings override same-named renderer fields and preserve the rest', () => {
    const out = buildAnalyzeArgs(
      { profile_dir: 'p', cache_dir: 'c' },
      { ...DEFAULT_SETTINGS, decode: 'software' },
      { path: 'D:/v.mp4', hwaccel: true, beside: 'yes' }
    )
    expect(out).toEqual({ profile_dir: 'p', cache_dir: 'c', path: 'D:/v.mp4', hwaccel: false, beside: false })
  })
  it('buildAnalyzeArgs: renderer-supplied profile_dir/cache_dir cannot override values chosen by main', () => {
    const out = buildAnalyzeArgs(
      { profile_dir: 'p', cache_dir: 'c' },
      { ...DEFAULT_SETTINGS },
      { path: 'D:/v.mp4', profile_dir: 'C:\\evil', cache_dir: 'C:\\evil-cache' }
    )
    expect(out.profile_dir).toBe('p')
    expect(out.cache_dir).toBe('c')
    expect(out.path).toBe('D:/v.mp4')
  })
})
