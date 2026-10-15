/** 僅開發模式：URL 帶 ?fixture=long 時，改用合成的 2 小時 300 事件資料集（見 longFixture.ts） */
export function longFixtureRequested(): boolean {
  return import.meta.env.DEV && new URLSearchParams(window.location.search).get('fixture') === 'long'
}

export const LONG_FIXTURE_PATH = 'fixture://long'
