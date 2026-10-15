import type { LibraryEntry } from '../../main/library'

/** 僅開發模式：URL 帶 ?fixture=library500 時，以合成的 500 筆影片庫資料取代真實資料 */
export function library500Requested(): boolean {
  return import.meta.env.DEV && new URLSearchParams(window.location.search).get('fixture') === 'library500'
}

const PREFIXES = ['Apex Legends', 'Apex Legends', 'Apex Legends', 'Ranked', 'Mixtape']
const DAY = 24 * 60 * 60 * 1000

/** 產生 count 筆合成影片庫資料：約 40 天、混合狀態、部分收藏與精華數 */
export function makeLibraryFixture(count = 500, now = Date.now()): LibraryEntry[] {
  const entries: LibraryEntry[] = []
  for (let i = 0; i < count; i++) {
    // 每天數支、越新的越前面
    const addedAt = now - Math.floor((i / count) * 40) * DAY - (i % 7) * 37 * 60 * 1000
    const roll = i % 11
    const base: LibraryEntry = {
      path: `D:\\fixture\\${PREFIXES[i % PREFIXES.length]}_${new Date(addedAt).toISOString().slice(0, 10)}_${String(i % 24).padStart(2, '0')}-${String(i % 60).padStart(2, '0')}-00-000.mp4`,
      addedAt,
      favorite: i % 9 === 0,
      status: 'done',
      progress: 1,
      durationSec: 300 + ((i * 37) % 9000),
      counts: { knock: (i * 7) % 40, assist: (i * 5) % 25 },
      hl: (i * 3) % 12,
      codec: i % 6 === 0 ? 'av1' : 'h264'
    }
    if (roll === 5) entries.push({ ...base, status: 'pending', progress: 0, counts: undefined, hl: 0, durationSec: undefined })
    else if (roll === 6) entries.push({ ...base, status: 'analyzing', progress: (i % 90) / 100, counts: undefined, hl: 0 })
    else if (roll === 7) entries.push({ ...base, status: 'error', progress: 0, error: 'ffprobe 回報檔案損壞（moov atom not found）', counts: undefined, hl: 0 })
    else entries.push(base)
  }
  return entries
}
