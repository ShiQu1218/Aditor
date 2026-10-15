import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { loadCacheDoc, saveCacheDoc } from './cache-io'

describe('cache save/load roundtrip', () => {
  it('preserves clip status and stale', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apexhl-'))
    const cache_path = path.join(dir, 'sub', 'v.apexhl.json')
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
