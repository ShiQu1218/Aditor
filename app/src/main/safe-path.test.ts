import { afterAll, describe, expect, test } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileExistsSafe, isSafeLocalVideoPath } from './safe-path'

describe('isSafeLocalVideoPath', () => {
  test('accepts normal absolute local video paths', () => {
    expect(isSafeLocalVideoPath('C:\\Videos\\a.mp4')).toBe(true)
    expect(isSafeLocalVideoPath('D:/Clips/b.MKV')).toBe(true)
    for (const e of ['mp4', 'mkv', 'mov', 'webm', 'm4v', 'avi']) expect(isSafeLocalVideoPath(`E:\\v\\x.${e}`)).toBe(true)
  })
  test('rejects non-strings', () => {
    for (const v of [undefined, null, 5, {}, [], ''] as unknown[]) expect(isSafeLocalVideoPath(v)).toBe(false)
  })
  test('rejects UNC / network / device paths', () => {
    expect(isSafeLocalVideoPath('\\\\server\\share\\a.mp4')).toBe(false)
    expect(isSafeLocalVideoPath('//server/share/a.mp4')).toBe(false)
    expect(isSafeLocalVideoPath('\\\\?\\C:\\a.mp4')).toBe(false)
    expect(isSafeLocalVideoPath('\\\\.\\C:\\a.mp4')).toBe(false)
    expect(isSafeLocalVideoPath('\\\\?\\UNC\\server\\share\\a.mp4')).toBe(false)
  })
  test('rejects relative and drive-relative paths', () => {
    expect(isSafeLocalVideoPath('a.mp4')).toBe(false)
    expect(isSafeLocalVideoPath('..\\a.mp4')).toBe(false)
    expect(isSafeLocalVideoPath('C:a.mp4')).toBe(false)
    expect(isSafeLocalVideoPath('/a.mp4')).toBe(false)
  })
  test('rejects wrong extension and NUL bytes', () => {
    expect(isSafeLocalVideoPath('C:\\a.txt')).toBe(false)
    expect(isSafeLocalVideoPath('C:\\a')).toBe(false)
    expect(isSafeLocalVideoPath('C:\\a.mp4\0.txt')).toBe(false)
  })
})

describe('fileExistsSafe', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-safe-'))
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  test('true only for existing regular files', async () => {
    const f = path.join(dir, 'a.mp4')
    fs.writeFileSync(f, 'x')
    expect(await fileExistsSafe(f)).toBe(true)
    expect(await fileExistsSafe(path.join(dir, 'nope.mp4'))).toBe(false)
  })
  test('directory named like a video is false', async () => {
    const d = path.join(dir, 'dir.mp4')
    fs.mkdirSync(d)
    expect(await fileExistsSafe(d)).toBe(false)
  })
  test('rejected paths never reach the filesystem and never throw', async () => {
    let called = 0
    const stat = (async () => {
      called++
      throw new Error('boom')
    }) as never
    expect(await fileExistsSafe('\\\\server\\share\\a.mp4', stat)).toBe(false)
    expect(await fileExistsSafe(42 as unknown as string, stat)).toBe(false)
    expect(called).toBe(0)
    expect(await fileExistsSafe('C:\\ok.mp4', stat)).toBe(false) // A stat error returns false.
    expect(called).toBe(1)
  })
})
