import { LONG_FIXTURE_PATH } from './fixture'

/** Development only (dynamically imported by App under import.meta.env.DEV and excluded from the production bundle): a sample project spanning two videos. */
export function fixtureProjectItems(): { id: string; source: string; start: number; end: number }[] {
  return [
    { id: 'fx1', source: LONG_FIXTURE_PATH, start: 50, end: 62 },
    { id: 'fx2', source: LONG_FIXTURE_PATH, start: 330, end: 345 },
    { id: 'fx3', source: 'D:/fixture/other-match.mp4', start: 10, end: 40 },
    { id: 'fx4', source: LONG_FIXTURE_PATH, start: 900, end: 906 },
    { id: 'fx5', source: 'D:/fixture/other-match.mp4', start: 120, end: 150 }
  ]
}
