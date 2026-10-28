import { describe, expect, test, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import { Readable } from 'stream'

// Packaged builds have no script interpreter: treat every child_process.spawn as a failure to verify that the default decompression path stays entirely in Node.
vi.mock('child_process', () => ({
  spawn: () => {
    throw new Error('spawn must not be used to decompress OpenH264')
  }
}))

import { downloadOpenH264 } from './codecs'

describe('downloadOpenH264 default decompression (packaged build)', () => {
  test('decompresses without spawning any process and without a script interpreter', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-codecs-pk-'))
    const body = fs.readFileSync(path.join(__dirname, '__fixtures__', 'multi.bz2'))
    const dll = await downloadOpenH264({
      dir,
      fetchStream: async () => ({ stream: Readable.from([body]), contentLength: body.length }),
      expected: { size: body.length, sha256: createHash('sha256').update(body).digest('hex') }
    })
    expect(fs.statSync(dll).size).toBe(350000)
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.part'))).toEqual([])
  })
})
