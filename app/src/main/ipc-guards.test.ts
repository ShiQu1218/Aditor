import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  createPathGrants,
  saveGrantedProject,
  loadGrantedProject,
  sanitizeAnalyzeArgs,
  sanitizeProbeArgs,
  sanitizeDeriveArgs,
  sanitizeAutoclipArgs,
  planCacheSave
} from './ipc-guards'
import { cacheFilePath } from './cache-io'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apexhl-guard-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('path grants (I1: project:save / project:load)', () => {
  it('refuses to write a path that was never chosen in a dialog', () => {
    const g = createPathGrants()
    const target = path.join(dir, 'evil.cmd')
    expect(saveGrantedProject(g, target, 'x')).toBe(false)
    expect(fs.existsSync(target)).toBe(false)
  })

  it('writes a dialog-granted path once, then requires a new grant', () => {
    const g = createPathGrants()
    const target = path.join(dir, 'p.apexproj.json')
    g.grant('save', target)
    expect(saveGrantedProject(g, target, '{"a":1}')).toBe(true)
    expect(fs.readFileSync(target, 'utf-8')).toBe('{"a":1}')
    expect(saveGrantedProject(g, target, '{"a":2}')).toBe(false)
  })

  it('grant matching is case/slash insensitive but kind-specific', () => {
    const g = createPathGrants()
    const target = path.join(dir, 'P.json')
    g.grant('open', target)
    expect(saveGrantedProject(g, target.toLowerCase(), 'x')).toBe(false)
    fs.writeFileSync(target, 'hello')
    expect(loadGrantedProject(g, target.toLowerCase().replace(/\\/g, '/'))).toBe('hello')
  })

  it('refuses non-.json targets even when granted, and never loads ungranted files', () => {
    const g = createPathGrants()
    const cmd = path.join(dir, 'startup.cmd')
    g.grant('save', cmd)
    expect(saveGrantedProject(g, cmd, 'x')).toBe(false)
    const secret = path.join(dir, 'secret.json')
    fs.writeFileSync(secret, 'secret')
    expect(loadGrantedProject(g, secret)).toBeNull()
  })
})

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
