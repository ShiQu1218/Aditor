import { CATEGORIES, type CategoryId } from '../settings/rows'

/** Development only: when the URL contains ?fixture=long, use a synthetic two-hour dataset with 300 events (see longFixture.ts). */
export function longFixtureRequested(): boolean {
  return import.meta.env.DEV && new URLSearchParams(window.location.search).get('fixture') === 'long'
}

export const LONG_FIXTURE_PATH = 'fixture://long'

/** Development only: ?fixture=long&project=1 requires preloading the sample project (see projectFixture.ts; dynamically imported). */
export function projectFixtureRequested(): boolean {
  if (!import.meta.env.DEV) return false
  const q = new URLSearchParams(window.location.search)
  return q.get('fixture') === 'long' && q.get('project') === '1'
}

/** Development only: ?fixture=long&drawer=settings|running|done|failed|consent opens the export drawer with fake IPC (see exportFixture.ts). */
export function drawerFixtureRequested(): 'settings' | 'running' | 'done' | 'failed' | 'consent' | null {
  if (!import.meta.env.DEV) return null
  const v = new URLSearchParams(window.location.search).get('drawer')
  return v === 'settings' || v === 'running' || v === 'done' || v === 'failed' || v === 'consent' ? v : null
}

/** Development only: ?fixture=settings[&cat=category id][&q=search term][&fail=1] opens settings directly with fake IPC (see settingsFixture.ts; fail=1 simulates a write failure). */
export function settingsFixtureRequested(): { cat: CategoryId; q: string; fail: boolean } | null {
  if (!import.meta.env.DEV) return null
  const p = new URLSearchParams(window.location.search)
  if (p.get('fixture') !== 'settings') return null
  const cat = CATEGORIES.find((c) => c.id === p.get('cat'))?.id ?? 'general'
  return { cat, q: p.get('q') ?? '', fail: p.get('fail') === '1' }
}

/** Development only: &lowperf=1 in the URL enables low-performance mode directly for screenshots; production builds always set it to false. */
export function lowPerfFixtureRequested(): boolean {
  return import.meta.env.DEV && new URLSearchParams(window.location.search).get('lowperf') === '1'
}
