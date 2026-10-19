import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { cacheFilePath, loadCacheDoc, saveCacheDoc } from './cache-io'

describe('cache save/load roundtrip', () => {
  it('preserves clip status and stale', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-'))
    const cache_path = path.join(dir, 'sub', 'v.aditor.json')
    const doc = {
      version: 1,
      cache_path,
      events: [],
      clips: [
        { id: 'a', start: 1, end: 5, origin: 'ai', event_ids: ['e1'], status: 'suggested' },
        { id: 'b', start: 9, end: 12, origin: 'ai', event_ids: [], status: 'skipped', stale: true }
      ]
    }
    expect(saveCacheDoc(doc)).toBe(true)
    const back = loadCacheDoc(cache_path) as typeof doc
    expect(back.clips).toEqual(doc.clips)
    expect(loadCacheDoc(path.join(dir, 'missing.json'))).toBeNull()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('cacheFilePath', () => {
  // path.resolve 依平台而異，磁碟機代號路徑只在 Windows 有意義 → 非 win32 明確跳過（顯示於報告）
  it.skipIf(process.platform !== 'win32')('matches the engine naming (sha1 of lowercased, slash-normalised absolute path) [win32 only: path.resolve drive semantics]', () => {
    // python: hashlib.sha1(b'd:/v/a.mp4').hexdigest()
    const expected = path.join('C:/cache', '10ad1835deb8203d4d73f32ede655b294e165740.json')
    expect(cacheFilePath('D:/v/a.mp4', 'C:/cache')).toBe(expected)
    expect(cacheFilePath('d:\\V\\A.mp4', 'C:/cache')).toBe(expected)
  })
})
