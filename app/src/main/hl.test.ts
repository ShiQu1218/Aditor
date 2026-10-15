import { describe, expect, test, vi } from 'vitest'
import { computeHlCount } from './hl'
import type { AutoClipParams, CacheDoc } from '../shared/types'

const PARAMS: AutoClipParams = { n: 3, gap: 20, before: 8, after: 4, max_len: 90 }
const ARGS = { profile_dir: 'C:/templates/zh-TW', cache_dir: 'C:/cache' }

function makeDoc(): CacheDoc {
  return {
    version: 1,
    video: { path: 'v.mp4', size: 1, mtime: 1, duration: 100, width: 1920, height: 1080, codec: 'h264', start_time: 0 },
    profile: 'zh-TW',
    analysis: { status: 'done', progress_t: 100, engine_version: '0.1.0', templates_version: 'zh-TW@1', h_scale: 1 },
    events: [
      {
        id: 'e1',
        t: 10,
        type: 'knock',
        score: 1,
        damage_line: false,
        name_sig: null,
        counted: true,
        counted_reason: 'first',
        counted_override: null,
        source: 'auto'
      }
    ],
    spectating: [],
    clips: [],
    keyframes: [],
    cache_path: 'C:/cache/x.json'
  }
}

describe('computeHlCount', () => {
  test('calls analyze (cache hit) then autoclip and returns clip count', async () => {
    const calls: Array<{ cmd: string; args: Record<string, unknown> }> = []
    const request = vi.fn(async (cmd: string, args: Record<string, unknown>) => {
      calls.push({ cmd, args })
      if (cmd === 'analyze') return makeDoc()
      if (cmd === 'autoclip') return { clips: [{ id: 'c1' }, { id: 'c2' }] }
      return null
    })

    const count = await computeHlCount(request, 'C:/v/a.mp4', PARAMS, ARGS)
    expect(count).toBe(2)
    expect(calls.map((c) => c.cmd)).toEqual(['analyze', 'autoclip'])
    expect(calls[0].args).toMatchObject({
      path: 'C:/v/a.mp4',
      profile_dir: ARGS.profile_dir,
      cache_dir: ARGS.cache_dir
    })
    expect(calls[1].args).toMatchObject({ params: PARAMS, duration: 100 })
    expect(calls[1].args.events).toEqual(makeDoc().events)
  })

  test('returns null when the cache doc is missing or autoclip fails', async () => {
    const noDoc = vi.fn(async () => null)
    expect(await computeHlCount(noDoc, 'v', PARAMS, ARGS)).toBeNull()

    const failing = vi.fn(async (cmd: string) => {
      if (cmd === 'analyze') return makeDoc()
      throw new Error('engine error')
    })
    expect(await computeHlCount(failing, 'v', PARAMS, ARGS)).toBeNull()

    // autoclip 回傳空 clips → 0（合法結果，不是失敗）
    const empty = vi.fn(async (cmd: string) => (cmd === 'analyze' ? makeDoc() : { clips: [] }))
    expect(await computeHlCount(empty, 'v', PARAMS, ARGS)).toBe(0)
  })
})
