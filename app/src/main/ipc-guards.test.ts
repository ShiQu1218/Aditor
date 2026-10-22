import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  sanitizeAnalyzeArgs,
  sanitizeProbeArgs,
  sanitizeDeriveArgs,
  sanitizeAutoclipArgs,
  sanitizeRemoveOptions,
  planCacheSave
} from './ipc-guards'
import { cacheFilePath } from './cache-io'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-guard-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('engine argument sanitizing (I1 / Minor 13)', () => {
  it('analyze keeps only a safe video path (+ force); drops cache_dir, profile_dir, beside, hwaccel', () => {
    expect(
      sanitizeAnalyzeArgs({ path: 'D:\\v\\a.mp4', cache_dir: 'C:\\evil', profile_dir: 'x', beside: true, force: true })
    ).toEqual({ path: 'D:\\v\\a.mp4', force: true })
    expect(sanitizeAnalyzeArgs({ path: 'D:\\v\\a.mp4' })).toEqual({ path: 'D:\\v\\a.mp4' })
  })
  it.each(['http://x/a.mp4', 'concat:a|b', '\\\\srv\\share\\a.mp4', 'D:\\v\\a.exe', 5, null])('rejects unsafe path %s', (p) => {
    expect(() => sanitizeAnalyzeArgs({ path: p })).toThrow()
    expect(() => sanitizeProbeArgs(p)).toThrow()
  })
  it('probe returns a path-only arg object', () => {
    expect(sanitizeProbeArgs('D:\\v\\a.mp4')).toEqual({ path: 'D:\\v\\a.mp4' })
  })
  it('derive cannot override profile_dir', () => {
    const r = sanitizeDeriveArgs({ events: [], spectating: [], profile: 'zh-TW', profile_dir: 'C:\\evil' })
    expect(r).toEqual({ events: [], spectating: [] })
  })
  it('autoclip passes only events/params/duration', () => {
    expect(sanitizeAutoclipArgs({ events: [], params: {}, duration: 3, extra: 1 })).toEqual({ events: [], params: {}, duration: 3 })
  })
})

describe('library:remove options (source file deletion)', () => {
  it('enables deletion only for deleteSource === true on a plain object', () => {
    expect(sanitizeRemoveOptions({ deleteSource: true })).toEqual({ deleteSource: true })
  })
  it.each([undefined, null, 'true', 1, [], [{ deleteSource: true }], {}, { deleteSource: 'true' }, { deleteSource: 1 }])(
    'keeps the files for %s',
    (raw) => {
      expect(sanitizeRemoveOptions(raw)).toEqual({ deleteSource: false })
    }
  )
})

describe('cache:save target (I1)', () => {
  const lib = (paths: string[]) => ({ get: (p: string) => (paths.includes(p) ? { path: p } : undefined) })
  it('ignores renderer cache_path and derives it from the library video', () => {
    const video = 'D:\\v\\a.mp4'
    const plan = planCacheSave({ cache_path: 'C:\\Users\\x\\Startup\\x.cmd', video: { path: video }, events: [] }, lib([video]), dir, false)
    expect(plan?.dest).toBe(cacheFilePath(video, dir, false))
    expect(plan?.doc.cache_path).toBe(plan?.dest)
  })
  it('rejects videos that are not in the library, or unsafe paths', () => {
    expect(planCacheSave({ cache_path: 'x', video: { path: 'D:\\v\\b.mp4' } }, lib([]), dir, false)).toBeNull()
    expect(planCacheSave({ video: { path: 'http://x/a.mp4' } }, lib(['http://x/a.mp4']), dir, false)).toBeNull()
    expect(planCacheSave(null, lib([]), dir, false)).toBeNull()
  })
})
