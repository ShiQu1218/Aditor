import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { linkOrCopyExclusive, writeFileAtomicSync } from './atomic-write'

describe('writeFileAtomicSync', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-atomic-'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('creates parents, syncs before renaming, and leaves no temporary file', () => {
    const file = path.join(dir, 'nested', 'data.json')
    const order: string[] = []
    const sync = fs.fsyncSync
    const rename = fs.renameSync
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      order.push('sync')
      sync(fd)
    })
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      order.push('rename')
      rename(from, to)
    })
    writeFileAtomicSync(file, '{"name":"café"}')
    expect(fs.readFileSync(file, 'utf-8')).toBe('{"name":"café"}')
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
    expect(order).toEqual(['sync', 'rename'])
  })

  it('writes the full content through writeFileSync on the temporary fd', () => {
    const file = path.join(dir, 'data.json')
    const text = '{"name":"café ☕","description":"longer than eight bytes"}'
    const open = vi.spyOn(fs, 'openSync')
    // This Node version bypasses the public writeSync for writeFileSync.
    const write = vi.spyOn(fs, 'writeFileSync')

    writeFileAtomicSync(file, text)

    expect(open).toHaveBeenCalledWith(`${file}.tmp`, 'w')
    expect(write).toHaveBeenCalledExactlyOnceWith(open.mock.results[0].value, text, 'utf-8')
    expect(fs.readFileSync(file, 'utf-8')).toBe(text)
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
  })

  it('removes the temporary file and throws when renaming fails', () => {
    const file = path.join(dir, 'existing-directory')
    fs.mkdirSync(file)
    expect(() => writeFileAtomicSync(file, 'data')).toThrow()
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
    expect(fs.statSync(file).isDirectory()).toBe(true)
  })
})

describe('writeFileAtomicSync lock retry', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-atomic-lock-'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('retries a rename blocked by a transient Windows lock', () => {
    const file = path.join(dir, 'library.json')
    fs.writeFileSync(file, 'old')
    const rename = fs.renameSync
    let calls = 0
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (++calls === 1) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
      rename(from, to)
    })
    writeFileAtomicSync(file, 'new')
    expect(calls).toBe(2)
    expect(fs.readFileSync(file, 'utf-8')).toBe('new')
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
  })

  it.each(['EBUSY', 'EACCES'])('gives up after three retries on a %s lock that does not clear', (code) => {
    const file = path.join(dir, 'library.json')
    fs.writeFileSync(file, 'old')
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error(`${code}: resource busy or locked, rename`), { code })
    })
    expect(() => writeFileAtomicSync(file, 'new')).toThrow(code)
    expect(rename).toHaveBeenCalledTimes(4)
    expect(fs.readFileSync(file, 'utf-8')).toBe('old')
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
  })

  it('does not retry errors other than file locks', () => {
    const file = path.join(dir, 'library.json')
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    })
    expect(() => writeFileAtomicSync(file, 'new')).toThrow('ENOSPC')
    expect(rename).toHaveBeenCalledOnce()
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
  })
})

describe('linkOrCopyExclusive', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-publish-'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('rejects with EEXIST and leaves an existing target untouched', async () => {
    const source = path.join(dir, 'part')
    const target = path.join(dir, 'out')
    fs.writeFileSync(source, 'new')
    fs.writeFileSync(target, 'old')
    await expect(linkOrCopyExclusive(source, target)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(fs.readFileSync(target, 'utf-8')).toBe('old')
  })

  it('falls back to an exclusive copy when hard links are unsupported', async () => {
    const source = path.join(dir, 'part')
    const target = path.join(dir, 'out')
    fs.writeFileSync(source, 'data')
    vi.spyOn(fs.promises, 'link').mockRejectedValueOnce(Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }))
    const copy = vi.spyOn(fs.promises, 'copyFile')
    await linkOrCopyExclusive(source, target)
    expect(copy).toHaveBeenCalledWith(source, target, fs.constants.COPYFILE_EXCL)
    expect(fs.readFileSync(target, 'utf-8')).toBe('data')
  })

  it('does not copy when linking fails for another reason', async () => {
    const copy = vi.spyOn(fs.promises, 'copyFile')
    await expect(linkOrCopyExclusive(path.join(dir, 'missing'), path.join(dir, 'out'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(copy).not.toHaveBeenCalled()
  })
})
