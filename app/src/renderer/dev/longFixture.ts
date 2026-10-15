import type { CacheDoc, Clip } from '../../shared/types'
import { LONG_SPECTATING, genLong } from '../../../test/fixtures/genEvents'

/** 僅開發模式使用（由 Viewer 在 import.meta.env.DEV 內動態載入，不進入正式 bundle） */
export function buildLongDoc(path: string): CacheDoc {
  const { events, duration } = genLong()
  // 取幾個事件密集處做示範片段：偶數為 AI 建議、其餘為已加入
  const clips: Clip[] = []
  for (let i = 12; i < events.length && clips.length < 8; i += 37) {
    const e = events[i]
    clips.push({
      id: 'fx_' + i,
      start: Math.max(0, e.t - 8),
      end: Math.min(duration, e.t + 14),
      origin: clips.length % 3 === 2 ? 'manual' : 'ai',
      event_ids: [e.id],
      status: clips.length % 2 === 0 ? 'suggested' : 'accepted'
    })
  }
  return {
    version: 1,
    video: { path, size: 0, mtime: 0, duration, width: 1916, height: 1080, codec: 'av1', start_time: 0 },
    profile: 'zh-TW',
    analysis: { status: 'done', progress_t: duration, engine_version: 'fixture', templates_version: 'fixture', h_scale: 1 },
    events,
    spectating: LONG_SPECTATING,
    clips,
    keyframes: [],
    cache_path: ''
  }
}
