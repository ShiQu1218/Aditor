import { describe, expect, test } from 'vitest'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { leadInSeek, subscribeStudioSettings, toStudioSettings, type StudioSettings } from './studioSettings'
import { studioNotice } from './notices'
import { planSuggestions } from './highlights'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const weak = { supported: false, smooth: false, powerEfficient: false }

describe('toStudioSettings (pure decision logic)', () => {
  test('Missing values or wrong types use defaults; valid values are preserved', () => {
    expect(toStudioSettings(undefined)).toMatchObject({ before: 8, proxySuggest: true, autoSuggestOnOpen: true })
    const s = toStudioSettings({ before: 3, after: 'x', proxySuggest: false, autoclip: { ...DEFAULT_SETTINGS.autoclip, n: 5 } })
    expect(s.before).toBe(3)
    expect(s).not.toHaveProperty('after')
    expect(s.proxySuggest).toBe(false)
    expect(s.autoclip.n).toBe(5)
  })

  test('Preview audio defaults and validation preserve valid saved values', () => {
    expect(toStudioSettings(undefined)).toMatchObject({ previewVolume: 100, previewMuted: false })
    expect(toStudioSettings({ previewVolume: 0, previewMuted: true })).toMatchObject({ previewVolume: 0, previewMuted: true })
    for (const previewVolume of [-1, 101, NaN, Infinity, '25', null]) {
      expect(toStudioSettings({ previewVolume, previewMuted: 'true' })).toMatchObject({ previewVolume: 100, previewMuted: false })
    }
  })
})

describe('leadInSeek uses the configured number of seconds', () => {
  test('leadInSeek = max(0, t - before)', () => {
    expect(leadInSeek(30, 8)).toBe(22)
    expect(leadInSeek(30, 3)).toBe(27)
    expect(leadInSeek(2, 8)).toBe(0)
  })
})

describe('proxySuggest → studioNotice', () => {
  test('Does not suggest a proxy when false; suggests one when true (the default)', () => {
    expect(studioNotice({ analysis: 'done', playability: weak, proxyState: 'none', proxySuggest: false })).toBeNull()
    expect(studioNotice({ analysis: 'done', playability: weak, proxyState: 'none', proxySuggest: true })?.id).toBe('proxy-suggest')
    expect(studioNotice({ analysis: 'done', playability: weak, proxyState: 'none' })?.id).toBe('proxy-suggest')
  })
  test('proxySuggest=false does not affect engine error notices', () => {
    expect(studioNotice({ analysis: 'error', playability: weak, proxyState: 'none', proxySuggest: false })?.kind).toBe('error')
  })
})

describe('autoclip defaults → automatic suggestions and AI popover', () => {
  test('planSuggestions receives settings.autoclip as an argument', () => {
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

describe('subscribeStudioSettings: initial read and immediate settings:changed updates', () => {
  test('Sends the initial value and subsequent changes to the consumer; stops after unsubscribe', async () => {
    const f = fakeApi({ ...DEFAULT_SETTINGS, before: 10, proxySuggest: false })
    const seen: StudioSettings[] = []
    const off = subscribeStudioSettings(f.api, (s) => seen.push(s))
    await tick()
    expect(seen.at(-1)).toMatchObject({ before: 10, proxySuggest: false })
    f.emit({ ...DEFAULT_SETTINGS, before: 2, after: 9, proxySuggest: true, autoclip: { ...DEFAULT_SETTINGS.autoclip, n: 9 } })
    expect(seen.at(-1)).toMatchObject({ before: 2, proxySuggest: true })
    expect(seen.at(-1)!.autoclip.n).toBe(9)
    off()
    expect(f.listeners.size).toBe(0)
    f.emit({ ...DEFAULT_SETTINGS, before: 1 })
    expect(seen.at(-1)!.before).toBe(2)
  })

  test('A newer changed event is not overwritten by a later get() response', async () => {
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

  test('Missing api or failed get() falls back to defaults without throwing', async () => {
    const seen: StudioSettings[] = []
    subscribeStudioSettings(undefined, (s) => seen.push(s))
    expect(seen.at(-1)).toMatchObject({ before: 8 })
    const bad = { settings: { get: async () => Promise.reject(new Error('x')) } }
    const seen2: StudioSettings[] = []
    subscribeStudioSettings(bad, (s) => seen2.push(s))
    await tick()
    expect(seen2.at(-1)).toMatchObject({ before: 8, autoSuggestOnOpen: false })
  })
})

describe('StudioScreen wiring (source scan: no more hardcoded 8/4)', () => {
  const src = readFileSync(resolve(__dirname, 'StudioScreen.tsx'), 'utf-8')
  test('Event lead-in seek uses the setting; blade mode does not use before/after seconds', () => {
    expect(src).not.toMatch(/createClipAt\([^)]*,\s*8,\s*4,/)
    expect(src).not.toMatch(/ev\.t\s*-\s*8/)
    expect(src).not.toMatch(/^\s*8,\s*\n\s*4,\s*\n\s*duration/m)
    expect(src).toMatch(/subscribeStudioSettings\(/)
    expect(src).not.toContain('createClipAt')
    expect(src).toMatch(/proxySuggest:\s*cfg\.proxySuggest/)
    expect(src).toMatch(/seekBefore=\{cfg\.before\}/)
  })
})
