import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { loadSettings, saveSettings, SettingsStore } from './settings'

describe('settings store（設定儲存）', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apexhl-settings-'))
    file = path.join(dir, 'settings.json')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('missing file returns defaults without creating file until first set', () => {
    expect(loadSettings(file)).toEqual(DEFAULT_SETTINGS)
    expect(fs.existsSync(file)).toBe(false)

    const store = new SettingsStore(file)
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
    expect(fs.existsSync(file)).toBe(false)

    // 第一次 set 才建立檔案
    store.set({ before: 10 })
    expect(fs.existsSync(file)).toBe(true)
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).before).toBe(10)
  })

  it('corrupt json is backed up to .bak and defaults returned', () => {
    fs.writeFileSync(file, '{ this is not valid json', 'utf-8')

    expect(loadSettings(file)).toEqual(DEFAULT_SETTINGS)
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.existsSync(`${file}.bak`)).toBe(true)
    expect(fs.readFileSync(`${file}.bak`, 'utf-8')).toBe('{ this is not valid json')
  })

  it('old/no-version file migrates and keeps known values', () => {
    // 舊檔沒有 version 欄位：已知值保留，缺少的補預設
    fs.writeFileSync(
      file,
      JSON.stringify({ before: 12, after: 2, watchFolders: ['D:/rec'], autoAnalyze: false }),
      'utf-8'
    )
    const s = loadSettings(file)
    expect(s.version).toBe(1)
    expect(s.before).toBe(12)
    expect(s.after).toBe(2)
    expect(s.watchFolders).toEqual(['D:/rec'])
    expect(s.autoAnalyze).toBe(false)
    expect(s.autoclip).toEqual(DEFAULT_SETTINGS.autoclip)

    // 較舊的版號一樣走遷移
    fs.writeFileSync(file, JSON.stringify({ version: 0, before: 6 }), 'utf-8')
    const s2 = loadSettings(file)
    expect(s2.version).toBe(1)
    expect(s2.before).toBe(6)
    expect(s2.after).toBe(DEFAULT_SETTINGS.after)
  })

  it('gameLang 遷移：無檔案（新安裝）→ auto；舊檔缺 gameLang 或值不合法 → zh-TW；合法值保留', () => {
    expect(loadSettings(file).gameLang).toBe('auto')
    expect(DEFAULT_SETTINGS.gameLang).toBe('auto')

    fs.writeFileSync(file, JSON.stringify({ version: 1, before: 5 }), 'utf-8')
    expect(loadSettings(file).gameLang).toBe('zh-TW')
    fs.writeFileSync(file, JSON.stringify({ before: 5 }), 'utf-8')
    expect(loadSettings(file).gameLang).toBe('zh-TW')
    fs.writeFileSync(file, JSON.stringify({ version: 1, gameLang: 'fr' }), 'utf-8')
    expect(loadSettings(file).gameLang).toBe('zh-TW')
    fs.writeFileSync(file, '[]', 'utf-8')
    expect(loadSettings(file).gameLang).toBe('auto')

    for (const lang of ['auto', 'zh-TW', 'en', 'ja']) {
      fs.writeFileSync(file, JSON.stringify({ version: 1, gameLang: lang }), 'utf-8')
      expect(loadSettings(file).gameLang).toBe(lang)
    }
  })

  it('lowPerfAsked：預設 false；非布林回退、布林保留並可持久化', () => {
    expect(DEFAULT_SETTINGS.lowPerfAsked).toBe(false)
    fs.writeFileSync(file, JSON.stringify({ version: 1, lowPerfAsked: 'yes' }), 'utf-8')
    expect(loadSettings(file).lowPerfAsked).toBe(false)
    fs.writeFileSync(file, JSON.stringify({ version: 1, lowPerfAsked: true }), 'utf-8')
    expect(loadSettings(file).lowPerfAsked).toBe(true)
    const store = new SettingsStore(file)
    expect(store.set({ lowPerfAsked: false }).settings.lowPerfAsked).toBe(false)
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).lowPerfAsked).toBe(false)
  })

  it('unknown keys dropped; wrong-typed field falls back to default individually', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        before: '八', // 型別不符 → 只回退此欄位
        after: 9, // 正確 → 保留
        lowPerfMode: true, // 正確 → 保留
        watchFolders: ['D:/ok', 42], // 陣列中非字串剔除
        autoclip: { n: '3', gap: 30 }, // n 型別不符回退、gap 保留
        unknownKey: 'x',
        telemetry: { on: true }
      }),
      'utf-8'
    )
    const s = loadSettings(file) as unknown as Record<string, unknown>

    // 整份不作廢：其他欄位保留；未知鍵全部丟棄
    expect(Object.keys(s).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort())
    expect(s.before).toBe(DEFAULT_SETTINGS.before)
    expect(s.after).toBe(9)
    expect(s.lowPerfMode).toBe(true)
    expect(s.watchFolders).toEqual(['D:/ok'])
    expect(s.autoclip).toEqual({ ...DEFAULT_SETTINGS.autoclip, gap: 30 })
  })

  it('set merges partial, validates ranges (before/after 0..30, autoclip bounds) and persists atomically', () => {
    const store = new SettingsStore(file)
    const renameSpy = vi.spyOn(fs, 'renameSync')

    const r1 = store.set({ before: 12, autoclip: { ...DEFAULT_SETTINGS.autoclip, n: 5 } })
    expect(r1.persisted).toBe(true)
    const s = r1.settings
    expect(s.before).toBe(12)
    expect(s.autoclip.n).toBe(5)

    // 原子寫入：暫存檔＋rename，且不留下暫存檔
    expect(renameSpy).toHaveBeenCalledTimes(1)
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(onDisk.version).toBe(1)
    expect(onDisk.before).toBe(12)
    expect(onDisk.autoclip.n).toBe(5)

    // 超出範圍／型別錯誤的欄位不生效（保留原值），合法欄位照常套用
    const s2 = store.set({
      before: 99,
      after: -1,
      autoclip: { ...s.autoclip, gap: 1000, max_len: 14 },
      lowPerfMode: true
    }).settings
    expect(s2.before).toBe(12)
    expect(s2.after).toBe(DEFAULT_SETTINGS.after)
    expect(s2.autoclip.gap).toBe(DEFAULT_SETTINGS.autoclip.gap)
    expect(s2.autoclip.max_len).toBe(DEFAULT_SETTINGS.autoclip.max_len)
    expect(s2.autoclip.n).toBe(5)
    expect(s2.lowPerfMode).toBe(true)

    // 邊界值（含端點）允許
    const s3 = store.set({ before: 0, after: 30 }).settings
    expect(s3.before).toBe(0)
    expect(s3.after).toBe(30)
  })

  it('failed rename leaves previous settings.json intact', () => {
    expect(saveSettings(file, { ...DEFAULT_SETTINGS, before: 10 })).toBe(true)
    const previous = fs.readFileSync(file, 'utf-8')
    const store = new SettingsStore(file)

    // 模擬 rename 失敗（例如檔案被鎖定）
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('EPERM: rename failed')
    })
    const r = store.set({ before: 5 })
    expect(r.settings.before).toBe(5) // 記憶體狀態仍更新，不丟錯
    expect(r.persisted).toBe(false) // 但明確回報沒有寫入磁碟
    expect(store.get().before).toBe(5)

    expect(fs.readFileSync(file, 'utf-8')).toBe(previous) // 舊檔完好
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).before).toBe(10)
    expect(fs.existsSync(`${file}.tmp`)).toBe(false) // 暫存檔已清掉
  })

  it('onChange fires once per set', () => {
    const store = new SettingsStore(file)
    const seen: number[] = []
    const off = store.onChange((s) => seen.push(s.before))

    store.set({ before: 1 })
    store.set({ before: 2 })
    expect(seen).toEqual([1, 2])

    off()
    store.set({ before: 3 })
    expect(seen).toEqual([1, 2])
  })

  it('set reports persisted:true on success and persisted:false when the write fails', () => {
    const store = new SettingsStore(file)
    expect(store.set({ before: 7 }).persisted).toBe(true)
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('ENOSPC: no space left')
    })
    const r = store.set({ before: 9 })
    expect(r.persisted).toBe(false)
    expect(r.settings.before).toBe(9)
  })

  it('a later successful set persists again (memory and disk converge)', () => {
    const store = new SettingsStore(file)
    const spy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('EPERM')
    })
    expect(store.set({ before: 5 }).persisted).toBe(false)
    spy.mockRestore()
    // 即使這次沒有任何欄位變更，仍要把先前未寫入的狀態補寫
    const r = store.set({})
    expect(r.persisted).toBe(true)
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).before).toBe(5)
  })

  it('invalid set leaves the file on disk byte-for-byte unchanged', () => {
    const store = new SettingsStore(file)
    store.set({ before: 12 })
    const before = fs.readFileSync(file, 'utf-8')
    const mtime = fs.statSync(file).mtimeMs
    const r = store.set({
      before: 99,
      after: -1,
      lowPerfMode: 'yes' as unknown as boolean,
      autoclip: { ...DEFAULT_SETTINGS.autoclip, gap: 1000 }
    })
    expect(r.persisted).toBe(true)
    expect(r.settings.before).toBe(12)
    expect(fs.readFileSync(file, 'utf-8')).toBe(before)
    expect(fs.statSync(file).mtimeMs).toBe(mtime)
  })

  it('a listener that throws does not abort set nor starve other listeners', () => {
    const store = new SettingsStore(file)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const seen: number[] = []
    store.onChange(() => {
      throw new Error('boom')
    })
    store.onChange((s) => seen.push(s.before))
    const r = store.set({ before: 4 })
    expect(r.persisted).toBe(true)
    expect(r.settings.before).toBe(4)
    expect(seen).toEqual([4])
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).before).toBe(4)
  })
})
