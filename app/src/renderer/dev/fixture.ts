/** 僅開發模式：URL 帶 ?fixture=long 時，改用合成的 2 小時 300 事件資料集（見 longFixture.ts） */
export function longFixtureRequested(): boolean {
  return import.meta.env.DEV && new URLSearchParams(window.location.search).get('fixture') === 'long'
}

export const LONG_FIXTURE_PATH = 'fixture://long'

/** 僅開發模式：?fixture=long&project=1 時，預先放入跨兩支影片的示範專案（截圖／手動驗收用） */
export function fixtureProjectItems(): { id: string; source: string; start: number; end: number }[] | null {
  if (!import.meta.env.DEV) return null
  const q = new URLSearchParams(window.location.search)
  if (q.get('fixture') !== 'long' || q.get('project') !== '1') return null
  return [
    { id: 'fx1', source: LONG_FIXTURE_PATH, start: 50, end: 62 },
    { id: 'fx2', source: LONG_FIXTURE_PATH, start: 330, end: 345 },
    { id: 'fx3', source: 'D:/fixture/other-match.mp4', start: 10, end: 40 },
    { id: 'fx4', source: LONG_FIXTURE_PATH, start: 900, end: 906 },
    { id: 'fx5', source: 'D:/fixture/other-match.mp4', start: 120, end: 150 }
  ]
}
