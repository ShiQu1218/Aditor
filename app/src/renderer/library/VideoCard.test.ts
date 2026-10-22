import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import type { LibraryEntry } from '../../main/library'
import { VideoCard, sameCardEntry } from './VideoCard'

const entry = (over: Partial<LibraryEntry> = {}): LibraryEntry => ({
  path: 'D:\v\a.mp4',
  addedAt: 1_700_000_000_000,
  favorite: false,
  status: 'done',
  progress: 1,
  durationSec: 300,
  counts: { knock: 2, assist: 1 },
  hl: 3,
  codec: 'h264',
  ...over
})

const noop = (): void => undefined
const html = (e: LibraryEntry): string =>
  renderToStaticMarkup(
    React.createElement(VideoCard, { entry: e, onOpen: noop, onToggleFavorite: noop, onRemove: noop, onRetry: noop })
  )

describe('VideoCard structure (valid ARIA, no nested interactive elements)', () => {
  const cases: Array<[string, LibraryEntry]> = [
    ['done', entry()],
    ['analyzing', entry({ status: 'analyzing', progress: 0.4 })],
    ['pending', entry({ status: 'pending', progress: 0 })],
    ['error', entry({ status: 'error', error: 'moov atom not found' })]
  ]
  test.each(cases)('%s card: article has no role/tabindex and buttons never nest', (_name, e) => {
    const out = html(e)
    expect(out).not.toMatch(/<article[^>]*(role=|tabindex)/i)
    expect(out).not.toMatch(/role="button"/)
    // No other <button> may appear between opening and closing this one.
    expect(out).not.toMatch(/<button\b(?:(?!<\/button>)[\s\S])*<button\b/)
    // Exactly one primary button.
    expect(out.match(/class="vcard-open"/g)).toHaveLength(1)
  })
  test('error card has retry and remove as siblings of the open button', () => {
    const out = html(entry({ status: 'error', error: 'x' }))
    const afterOpen = out.slice(out.indexOf('</button>'))
    expect(afterOpen).toContain('vcard-error-actions')
    expect(afterOpen).toContain('vcard-fav')
    expect(afterOpen).toContain('vcard-more')
  })
})

describe('sameCardEntry (memo comparator: only the changed card re-renders)', () => {
  const base = entry()
  test('identical content is equal even for a new object', () => {
    expect(sameCardEntry(base, { ...base })).toBe(true)
  })
  test.each<[string, Partial<LibraryEntry>]>([
    ['progress', { progress: 0.5 }],
    ['status', { status: 'error' }],
    ['favorite', { favorite: true }],
    ['error', { error: 'boom' }],
    ['hl', { hl: 9 }],
    ['durationSec', { durationSec: 1 }],
    ['thumb', { thumb: 'x.jpg' }],
    ['analyzingSince', { analyzingSince: 5 }],
    ['counts.knock', { counts: { knock: 9, assist: 1 } }],
    ['counts.assist', { counts: { knock: 2, assist: 9 } }]
  ])('a change in %s makes the card re-render', (_k, over) => {
    expect(sameCardEntry(base, { ...base, ...over })).toBe(false)
  })
  test('updating one card in a list leaves every other card skipping re-render', () => {
    const before = Array.from({ length: 50 }, (_, i) => entry({ path: `p${i}`, status: i === 7 ? 'analyzing' : 'done', progress: i === 7 ? 0.1 : 1 }))
  const after = before.map((e) => (e.path === 'p7' ? { ...e, progress: 0.2 } : { ...e })) // main sends a new object each time.
    const changed = after.filter((e, i) => !sameCardEntry(before[i], e)).map((e) => e.path)
    expect(changed).toEqual(['p7'])
  })
})

describe('proxySuggest setting → “Proxy suggested” card badge', () => {
  const av1 = entry({ codec: 'av1' })
  test('Badge appears by default (omitted) and for true, but not false (AV1 also suggests a proxy)', () => {
    expect(html(av1)).toContain('建議代理檔')
    const withProp = (v: boolean): string =>
      renderToStaticMarkup(
        React.createElement(VideoCard, { entry: av1, proxySuggest: v, onOpen: noop, onToggleFavorite: noop, onRemove: noop, onRetry: noop })
      )
    expect(withProp(true)).toContain('建議代理檔')
    expect(withProp(false)).not.toContain('建議代理檔')
  })
  test('memo comparator rerenders the card when proxySuggest changes', () => {
    const cmp = (VideoCard as unknown as { compare: (a: unknown, b: unknown) => boolean }).compare
    const base = { entry: av1, proxySuggest: true }
    expect(cmp(base, { entry: { ...av1 }, proxySuggest: true })).toBe(true)
    expect(cmp(base, { entry: av1, proxySuggest: false })).toBe(false)
  })
})

describe('imported tag (external entries)', () => {
  test('an imported entry shows the tag in the card meta line', () => {
    const out = html(entry({ source: 'external' }))
    expect(out).toContain('vcard-imported')
    expect(out).toContain('外部匯入')
    // The tag sits next to the game tag.
    expect(out.indexOf('vcard-game')).toBeLessThan(out.indexOf('vcard-imported'))
  })
  test('recordings and legacy entries have no imported tag', () => {
    expect(html(entry({ source: 'recording' }))).not.toContain('vcard-imported')
    expect(html(entry())).not.toContain('vcard-imported')
  })
  test('the memo comparator rerenders the card when the source changes', () => {
    const base = entry()
    expect(sameCardEntry(base, { ...base, source: 'external' })).toBe(false)
    expect(sameCardEntry({ ...base, source: 'external' }, { ...base, source: 'external' })).toBe(true)
  })
})

describe('LibraryScreen wiring (source scan)', () => {
  test('Subscribes to settings and passes proxySuggest to each card', async () => {
    const { readFileSync } = await import('fs')
    const { resolve } = await import('path')
    const src = readFileSync(resolve(__dirname, 'LibraryScreen.tsx'), 'utf-8')
    expect(src).toMatch(/subscribeStudioSettings\(window\.api/)
    expect(src).toMatch(/proxySuggest=\{proxySuggest\}/)
  })
})
