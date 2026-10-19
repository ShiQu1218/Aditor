import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { prepareStorageRoot, suggestStorageRoot } from './storage-root'

describe('prepareStorageRoot', () => {
  let tmp: string
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-root-')) })
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  test('建立根、Recordings、Exports、Exports/Merged、Exports/Clips', () => {
    const root = path.join(tmp, 'Apex')
    const r = prepareStorageRoot(root)
    expect(r).toEqual({ root, recordingsDir: path.join(root, 'Recordings'), exportsDir: path.join(root, 'Exports') })
    for (const sub of ['', 'Recordings', 'Exports', 'Exports/Merged', 'Exports/Clips']) {
      expect(fs.statSync(path.join(root, sub)).isDirectory(), sub).toBe(true)
    }
  })

  test('已存在的資料夾與內容不受影響', () => {
    const root = path.join(tmp, 'Apex')
    fs.mkdirSync(path.join(root, 'Recordings'), { recursive: true })
    fs.writeFileSync(path.join(root, 'Recordings', 'a.mp4'), 'x')
    prepareStorageRoot(root)
    expect(fs.readFileSync(path.join(root, 'Recordings', 'a.mp4'), 'utf-8')).toBe('x')
  })

  test('相對路徑、非字串、空字串都丟錯', () => {
    expect(() => prepareStorageRoot('relative/dir')).toThrow(/本機絕對路徑/)
    expect(() => prepareStorageRoot(42)).toThrow(/本機絕對路徑/)
    expect(() => prepareStorageRoot('')).toThrow(/本機絕對路徑/)
  })

  test.runIf(process.platform === 'win32')('UNC 路徑被拒絕', () => {
    expect(() => prepareStorageRoot('\\\\server\\share\\x')).toThrow(/本機絕對路徑/)
  })

  test('根路徑是檔案時丟錯並說明原因', () => {
    const file = path.join(tmp, 'file.txt')
    fs.writeFileSync(file, 'x')
    expect(() => prepareStorageRoot(file)).toThrow(/無法建立或寫入/)
  })

  test('資料夾不可寫入時丟錯（以假的 fs 模擬）', () => {
    const root = path.join(tmp, 'Apex')
    const fake = { ...fs, writeFileSync: () => { throw new Error('EACCES') } } as unknown as typeof fs
    expect(() => prepareStorageRoot(root, fake)).toThrow(/無法建立或寫入/)
  })

  test('寫入探測檔不會留下', () => {
    const root = path.join(tmp, 'Apex')
    prepareStorageRoot(root)
    expect(fs.readdirSync(root).sort()).toEqual(['Exports', 'Recordings'])
  })
})

describe('suggestStorageRoot', () => {
  const sep = path.sep
  const drive = (letter: string): string => `${letter}:${sep}`
  const videos = path.join(drive('C'), 'Users', 'me', 'Videos')
  const fallback = path.join(videos, 'Aditor')

  test('錄影資料夾名稱是 Recordings 時採用它的上一層', () => {
    const root = path.join(drive('D'), 'Games', 'Apex')
    expect(suggestStorageRoot({ recordingOutputDir: path.join(root, 'Recordings'), defaultOutDir: null, videosDir: videos })).toBe(root)
  })

  test('其次 defaultOutDir 名稱是 Exports 時採用上一層', () => {
    const root = path.join(drive('E'), 'Clips')
    expect(suggestStorageRoot({ recordingOutputDir: null, defaultOutDir: path.join(root, 'Exports'), videosDir: videos })).toBe(root)
  })

  test('錄影資料夾優先於匯出資料夾', () => {
    const a = path.join(drive('D'), 'A')
    const b = path.join(drive('E'), 'B')
    expect(suggestStorageRoot({ recordingOutputDir: path.join(a, 'Recordings'), defaultOutDir: path.join(b, 'Exports'), videosDir: videos })).toBe(a)
  })

  test('名稱不符時使用 影片資料夾/Aditor', () => {
    expect(suggestStorageRoot({
      recordingOutputDir: path.join(drive('D'), 'Other'),
      defaultOutDir: path.join(drive('D'), 'Out'),
      videosDir: videos
    })).toBe(fallback)
    expect(suggestStorageRoot({ recordingOutputDir: null, defaultOutDir: null, videosDir: videos })).toBe(fallback)
  })

  test.runIf(process.platform === 'win32')('名稱比對不分大小寫', () => {
    expect(suggestStorageRoot({ recordingOutputDir: 'D:\\Apex\\recordings', defaultOutDir: null, videosDir: videos })).toBe('D:\\Apex')
  })
})
