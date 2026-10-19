import { describe, expect, test, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import { Readable } from 'stream'

// 打包版沒有 engine/.venv 的 Python：任何 child_process.spawn 都視為失敗，驗證預設解壓縮路徑完全在 Node 內。
vi.mock('child_process', () => ({
  spawn: () => {
    throw new Error('spawn must not be used to decompress OpenH264')
  }
}))

import { downloadOpenH264 } from './codecs'

describe('downloadOpenH264 default decompression (packaged build, no Python)', () => {
  test('decompresses without spawning any process and without the dev .venv', async () => {
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
