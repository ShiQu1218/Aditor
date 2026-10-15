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

    const s = store.set({ before: 12, autoclip: { ...DEFAULT_SETTINGS.autoclip, n: 5 } })
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
    })
    expect(s2.before).toBe(12)
    expect(s2.after).toBe(DEFAULT_SETTINGS.after)
    expect(s2.autoclip.gap).toBe(DEFAULT_SETTINGS.autoclip.gap)
    expect(s2.autoclip.max_len).toBe(DEFAULT_SETTINGS.autoclip.max_len)
    expect(s2.autoclip.n).toBe(5)
    expect(s2.lowPerfMode).toBe(true)

    // 邊界值（含端點）允許
    const s3 = store.set({ before: 0, after: 30 })
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
    const s = store.set({ before: 5 })
    expect(s.before).toBe(5) // 記憶體狀態仍更新，不丟錯

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
})
