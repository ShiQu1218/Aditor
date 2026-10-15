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
    // 任何 <button> 開啟後、關閉前不得再出現 <button>
    expect(out).not.toMatch(/<button\b(?:(?!<\/button>)[\s\S])*<button\b/)
    // 恰一個主要按鈕
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
    const after = before.map((e) => (e.path === 'p7' ? { ...e, progress: 0.2 } : { ...e })) // main 每次送新物件
    const changed = after.filter((e, i) => !sameCardEntry(before[i], e)).map((e) => e.path)
    expect(changed).toEqual(['p7'])
  })
})
