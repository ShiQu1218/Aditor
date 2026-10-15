/** 僅開發模式：URL 帶 ?fixture=long 時，改用合成的 2 小時 300 事件資料集（見 longFixture.ts） */
export function longFixtureRequested(): boolean {
  return import.meta.env.DEV && new URLSearchParams(window.location.search).get('fixture') === 'long'
}

export const LONG_FIXTURE_PATH = 'fixture://long'

/** 僅開發模式：?fixture=long&project=1 → 需要預先放入示範專案（內容見 projectFixture.ts，動態載入） */
export function projectFixtureRequested(): boolean {
  if (!import.meta.env.DEV) return false
  const q = new URLSearchParams(window.location.search)
  return q.get('fixture') === 'long' && q.get('project') === '1'
}
