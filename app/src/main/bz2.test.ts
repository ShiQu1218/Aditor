import { describe, expect, test } from 'vitest'
import fs from 'fs'
import path from 'path'
import { bunzip2 } from './bz2'

const fx = (n: string): Buffer => fs.readFileSync(path.join(__dirname, '__fixtures__', n))

/** Deterministic data matching the reference generator for multi.bz2 (350000 bytes, including long runs across multiple 100k blocks). */
export function genData(n: number): Buffer {
  const b: number[] = []
  let x = 12345
  while (b.length < n) {
    x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff
    const k = ((x >> 16) % 10)
    if (k < 3) {
      const len = 1 + ((x >> 4) % 40)
      for (let i = 0; i < len; i++) b.push(65 + ((x >> 8) % 7))
    } else if (k < 5) {
      const len = 4 + ((x >> 4) % 300)
      for (let i = 0; i < len; i++) b.push((x >> 8) & 255)
    } else b.push(k > 7 ? (x >> 8) & 255 : 97 + ((x >> 8) % 5))
  }
  return Buffer.from(b.slice(0, n))
}

describe('bunzip2 (pure TS)', () => {
  test('decodes a small stream', () => {
    expect(bunzip2(fx('small.bz2')).toString()).toBe('hello hello hello apex'.repeat(3))
  })
  test('decodes an empty stream', () => {
    expect(bunzip2(fx('empty.bz2')).length).toBe(0)
  })
  test('decodes a multi-block stream with long runs (matches the reference bz2 stream)', () => {
    const out = bunzip2(fx('multi.bz2'))
    expect(out.length).toBe(350000)
    expect(out.equals(genData(350000))).toBe(true)
  })
  test('rejects corrupted data via CRC', () => {
    const bad = Buffer.from(fx('multi.bz2'))
    bad[bad.length >> 1] ^= 0x55
    expect(() => bunzip2(bad)).toThrow()
  })
  test('rejects non-bzip2 input', () => {
    expect(() => bunzip2(Buffer.from('not bz2 at all'))).toThrow()
  })
})
