import { describe, expect, test } from 'vitest'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { leadInSeek, subscribeStudioSettings, toStudioSettings, type StudioSettings } from './studioSettings'
import { createClipAt, supercut } from '../timeline/clips'
import { studioNotice } from './notices'
import { planSuggestions } from './highlights'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const weak = { supported: false, smooth: false, powerEfficient: false }

describe('toStudioSettings（純決策）', () => {
  test('缺值／型別錯誤 → 預設；合法值保留', () => {
    expect(toStudioSettings(undefined)).toMatchObject({ before: 8, after: 4, proxySuggest: true, autoSuggestOnOpen: true })
    const s = toStudioSettings({ before: 3, after: 'x', proxySuggest: false, autoclip: { ...DEFAULT_SETTINGS.autoclip, n: 5 } })
    expect(s.before).toBe(3)
    expect(s.after).toBe(DEFAULT_SETTINGS.after)
    expect(s.proxySuggest).toBe(false)
    expect(s.autoclip.n).toBe(5)
  })
})

describe('leadInSeek / 快速剪輯 / 合輯使用設定的前後秒數', () => {
  test('leadInSeek = max(0, t - before)', () => {
    expect(leadInSeek(30, 8)).toBe(22)
    expect(leadInSeek(30, 3)).toBe(27)
    expect(leadInSeek(2, 8)).toBe(0)
  })
  test('createClipAt／supercut 吃 settings.before/after（不再固定 8/4）', () => {
    const s = toStudioSettings({ before: 5, after: 2 })
    const c = createClipAt(100, s.before, s.after, 600)
    expect([c.start, c.end]).toEqual([95, 102])
    const ev = [{ id: 'e', t: 50, type: 'knock', conf: 1, counted: true, deleted: false }] as never
    const [sc] = supercut(ev, new Set(['e']), s.before, s.after, 600)
    expect([sc.start, sc.end]).toEqual([45, 52])
  })
})

describe('proxySuggest → studioNotice', () => {
  test('false 時不建議代理檔；true（預設）才建議', () => {
    expect(studioNotice({ analysis: 'done', playability: weak, proxyState: 'none', proxySuggest: false })).toBeNull()
    expect(studioNotice({ analysis: 'done', playability: weak, proxyState: 'none', proxySuggest: true })?.id).toBe('proxy-suggest')
    expect(studioNotice({ analysis: 'done', playability: weak, proxyState: 'none' })?.id).toBe('proxy-suggest')
  })
  test('proxySuggest=false 不影響引擎錯誤通知', () => {
    expect(studioNotice({ analysis: 'error', playability: weak, proxyState: 'none', proxySuggest: false })?.kind).toBe('error')
  })
})

describe('autoclip 預設 → 自動建議與 AI 浮層', () => {
  test('planSuggestions 以 settings.autoclip 為參數', () => {
    const settings: StudioSettings = toStudioSettings({ autoclip: { n: 7, gap: 30, before: 6, after: 3, max_len: 120 } })
    const doc = {
      analysis: { status: 'done' },
      events: [{ id: 'e', t: 1, type: 'knock', conf: 1, counted: true, deleted: false }],
      clips: [],
      spectating: []
    } as never
    const plan = planSuggestions({ doc, clips: [], settings })
    expect(plan.kind).toBe('place')
    expect((plan as { params: unknown }).params).toEqual(settings.autoclip)
  })
})

function fakeApi(initial: unknown) {
  const listeners = new Set<(s: unknown) => void>()
  let current = initial
  return {
    api: {
      settings: {
        get: async () => current,
        onChanged: (cb: (s: unknown) => void) => {
          listeners.add(cb)
          return () => listeners.delete(cb)
        }
      }
    },
    emit: (s: unknown) => {
      current = s
      listeners.forEach((l) => l(s))
    },
    listeners
  }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('subscribeStudioSettings：讀取＋settings:changed 即時生效', () => {
  test('初始值與後續變更都送到 consumer；解除訂閱後不再送', async () => {
    const f = fakeApi({ ...DEFAULT_SETTINGS, before: 10, proxySuggest: false })
    const seen: StudioSettings[] = []
    const off = subscribeStudioSettings(f.api, (s) => seen.push(s))
    await tick()
    expect(seen.at(-1)).toMatchObject({ before: 10, proxySuggest: false })
    f.emit({ ...DEFAULT_SETTINGS, before: 2, after: 9, proxySuggest: true, autoclip: { ...DEFAULT_SETTINGS.autoclip, n: 9 } })
    expect(seen.at(-1)).toMatchObject({ before: 2, after: 9, proxySuggest: true })
    expect(seen.at(-1)!.autoclip.n).toBe(9)
    off()
    expect(f.listeners.size).toBe(0)
    f.emit({ ...DEFAULT_SETTINGS, before: 1 })
    expect(seen.at(-1)!.before).toBe(2)
  })

  test('較新的 changed 事件不會被較晚回來的 get() 蓋掉', async () => {
    let resolveGet!: (v: unknown) => void
    const listeners = new Set<(s: unknown) => void>()
    const api = {
      settings: {
        get: () => new Promise((r) => (resolveGet = r)),
        onChanged: (cb: (s: unknown) => void) => (listeners.add(cb), () => listeners.delete(cb))
      }
    }
    const seen: StudioSettings[] = []
    subscribeStudioSettings(api, (s) => seen.push(s))
    listeners.forEach((l) => l({ ...DEFAULT_SETTINGS, before: 20 }))
    resolveGet({ ...DEFAULT_SETTINGS, before: 1 })
    await tick()
    expect(seen.at(-1)!.before).toBe(20)
  })

  test('沒有 api／get 失敗 → 回退預設，不拋錯', async () => {
    const seen: StudioSettings[] = []
    subscribeStudioSettings(undefined, (s) => seen.push(s))
    expect(seen.at(-1)).toMatchObject({ before: 8, after: 4 })
    const bad = { settings: { get: async () => Promise.reject(new Error('x')) } }
    const seen2: StudioSettings[] = []
    subscribeStudioSettings(bad, (s) => seen2.push(s))
    await tick()
    expect(seen2.at(-1)).toMatchObject({ before: 8, after: 4, autoSuggestOnOpen: false })
  })
})

describe('StudioScreen 接線（原始碼掃描：不得再有寫死的 8/4）', () => {
  const src = readFileSync(resolve(__dirname, 'StudioScreen.tsx'), 'utf-8')
  test('快速剪輯、合輯、事件 lead-in seek 都用設定值', () => {
    expect(src).not.toMatch(/createClipAt\([^)]*,\s*8,\s*4,/)
    expect(src).not.toMatch(/ev\.t\s*-\s*8/)
    expect(src).not.toMatch(/^\s*8,\s*\n\s*4,\s*\n\s*duration/m)
    expect(src).toMatch(/subscribeStudioSettings\(/)
    expect(src).toMatch(/createClipAt\(sourcePlayTime\(\),\s*cfg\.before,\s*cfg\.after/)
    expect(src).toMatch(/proxySuggest:\s*cfg\.proxySuggest/)
    expect(src).toMatch(/seekBefore=\{cfg\.before\}/)
  })
})
