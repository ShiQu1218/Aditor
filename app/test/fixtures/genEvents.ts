import type { EngineEvent, EventType } from '../../src/shared/types'

/** 與 docs/design/ui-mock/js/data.js 的 genLong 同演算法（確定性 LCG，不使用 Math.random） */
export const LONG_DURATION = 8240.5
export const LONG_SPECTATING = [
  { start: 2650, end: 2702 },
  { start: 5120, end: 5181 },
  { start: 7905, end: 7962 }
]

/** extraRandom：額外的隨機散布事件數（效能測試用，預設 0 即與 mock 相同的約 300 個） */
export function genLong(extraRandom = 0): { events: EngineEvent[]; duration: number } {
  let seed = 7
  const r = (): number => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }
  const dur = LONG_DURATION
  const pick = (): EventType => {
    const x = r()
    return x < 0.5
      ? 'knock'
      : x < 0.62
        ? 'assist_knock'
        : x < 0.72
          ? 'assist_elim'
          : x < 0.9
            ? 'elim'
            : 'squad_wipe'
  }
  const raw: { t: number; type: EventType; score: number }[] = []
  const push = (t: number, big: boolean): void => {
    const type = big ? 'knock' : pick()
    const score = 0.8 + r() * 0.19
    if (type === 'knock') r() // dmg 旗標（保持亂數序列與 mock 一致）
    raw.push({ t: Math.round(t * 4) / 4, type, score })
  }
  for (let f = 0; f < 46; f++) {
    const n = f % 7 === 0 ? 7 : f % 3 === 0 ? 5 : 3 + Math.floor(r() * 2)
    let t = 120 + f * ((dur - 300) / 46) + r() * 60
    for (let i = 0; i < n; i++) {
      t += 3 + r() * 13
      push(t, i === 0)
    }
  }
  for (let i = 0; i < 100 + extraRandom; i++) push(60 + r() * (dur - 120), false)
  raw.sort((a, b) => a.t - b.t)
  const events = raw.map((e, i): EngineEvent => {
    const inSpec = LONG_SPECTATING.some((s) => e.t >= s.start && e.t <= s.end)
    const wipe = e.type === 'squad_wipe'
    const dup = !inSpec && !wipe && r() > 0.82
    const counted = !inSpec && !wipe && !dup
    return {
      id: 'L' + i,
      t: e.t,
      type: e.type,
      score: e.score,
      damage_line: false,
      name_sig: null,
      counted,
      counted_reason: inSpec ? 'spectating' : wipe ? 'not_counting_type' : dup ? 'duplicate' : 'first',
      counted_override: null,
      source: 'auto'
    }
  })
  return { events, duration: dur }
}
