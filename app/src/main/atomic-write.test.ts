import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { writeFileAtomicSync } from './atomic-write'

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

  it('removes the temporary file and throws when renaming fails', () => {
    const file = path.join(dir, 'existing-directory')
    fs.mkdirSync(file)
    expect(() => writeFileAtomicSync(file, 'data')).toThrow()
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
    expect(fs.statSync(file).isDirectory()).toBe(true)
  })
})
