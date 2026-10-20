import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { prepareStorageRoot, suggestStorageRoot } from './storage-root'

describe('prepareStorageRoot', () => {
  let tmp: string
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-root-')) })
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  test('creates the root, Recordings, Exports, Exports/Merged, and Exports/Clips', () => {
    const root = path.join(tmp, 'Apex')
    const r = prepareStorageRoot(root)
    expect(r).toEqual({ root, recordingsDir: path.join(root, 'Recordings'), exportsDir: path.join(root, 'Exports') })
    for (const sub of ['', 'Recordings', 'Exports', 'Exports/Merged', 'Exports/Clips']) {
      expect(fs.statSync(path.join(root, sub)).isDirectory(), sub).toBe(true)
    }
  })

  test('leaves existing directories and their contents unchanged', () => {
    const root = path.join(tmp, 'Apex')
    fs.mkdirSync(path.join(root, 'Recordings'), { recursive: true })
    fs.writeFileSync(path.join(root, 'Recordings', 'a.mp4'), 'x')
    prepareStorageRoot(root)
    expect(fs.readFileSync(path.join(root, 'Recordings', 'a.mp4'), 'utf-8')).toBe('x')
  })

  test('rejects relative paths, non-strings, and empty strings', () => {
    expect(() => prepareStorageRoot('relative/dir')).toThrow(/本機絕對路徑/)
    expect(() => prepareStorageRoot(42)).toThrow(/本機絕對路徑/)
    expect(() => prepareStorageRoot('')).toThrow(/本機絕對路徑/)
  })

  test.runIf(process.platform === 'win32')('rejects UNC paths', () => {
    expect(() => prepareStorageRoot('\\\\server\\share\\x')).toThrow(/本機絕對路徑/)
  })

  test('rejects a file used as the root path and explains why', () => {
    const file = path.join(tmp, 'file.txt')
    fs.writeFileSync(file, 'x')
    expect(() => prepareStorageRoot(file)).toThrow(/無法建立或寫入/)
  })

  test('rejects an unwritable directory (simulated with a fake fs)', () => {
    const root = path.join(tmp, 'Apex')
    const fake = { ...fs, writeFileSync: () => { throw new Error('EACCES') } } as unknown as typeof fs
    expect(() => prepareStorageRoot(root, fake)).toThrow(/無法建立或寫入/)
  })

  test('does not leave the write-probe file behind', () => {
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

  test('uses the parent directory when the recording folder is named Recordings', () => {
    const root = path.join(drive('D'), 'Games', 'Apex')
    expect(suggestStorageRoot({ recordingOutputDir: path.join(root, 'Recordings'), defaultOutDir: null, videosDir: videos })).toBe(root)
  })

  test('otherwise uses the parent directory when defaultOutDir is named Exports', () => {
    const root = path.join(drive('E'), 'Clips')
    expect(suggestStorageRoot({ recordingOutputDir: null, defaultOutDir: path.join(root, 'Exports'), videosDir: videos })).toBe(root)
  })

  test('prefers the recording folder over the export folder', () => {
    const a = path.join(drive('D'), 'A')
    const b = path.join(drive('E'), 'B')
    expect(suggestStorageRoot({ recordingOutputDir: path.join(a, 'Recordings'), defaultOutDir: path.join(b, 'Exports'), videosDir: videos })).toBe(a)
  })

  test('uses Videos/Aditor when folder names do not match', () => {
    expect(suggestStorageRoot({
      recordingOutputDir: path.join(drive('D'), 'Other'),
      defaultOutDir: path.join(drive('D'), 'Out'),
      videosDir: videos
    })).toBe(fallback)
    expect(suggestStorageRoot({ recordingOutputDir: null, defaultOutDir: null, videosDir: videos })).toBe(fallback)
  })

  test.runIf(process.platform === 'win32')('matches names case-insensitively', () => {
    expect(suggestStorageRoot({ recordingOutputDir: 'D:\\Apex\\recordings', defaultOutDir: null, videosDir: videos })).toBe('D:\\Apex')
  })
})
