import { describe, expect, it } from 'vitest'
import { DRIFT_SUSTAIN_MS, DRIFT_THRESHOLD_S, SETTLE_MS, settle, stepSync, type SyncState } from './avSync'

function run(samples: Array<[number, number]>, start: SyncState = settle(0)): { state: SyncState; desync: boolean } {
  let state = start
  let desync = false
  for (const [nowMs, drift] of samples) ({ state, desync } = stepSync(state, nowMs, drift))
  return { state, desync }
}

describe('A/V desync detector', () => {
  const t0 = SETTLE_MS
  it('ignores drift during the settle window after play, seek or stall', () => {
    expect(run([[0, 1], [SETTLE_MS - 1, 1]]).desync).toBe(false)
  })
  it('does not flag normal frame latency', () => {
    const samples: Array<[number, number]> = []
    for (let t = t0; t < t0 + 10_000; t += 33) samples.push([t, DRIFT_THRESHOLD_S / 2])
    expect(run(samples).desync).toBe(false)
  })
  it('flags drift that persists for the sustain period, in either direction', () => {
    for (const drift of [0.6, -0.6]) {
      const r = run([[t0, drift], [t0 + DRIFT_SUSTAIN_MS, drift]])
      expect(r.desync).toBe(true)
      expect(r.state.worstDriftS).toBeCloseTo(0.6)
    }
  })
  it('resets the breach when a single sample returns in range', () => {
    expect(run([[t0, 0.6], [t0 + 1000, 0.01], [t0 + DRIFT_SUSTAIN_MS, 0.6]]).desync).toBe(false)
  })
  it('treats NaN drift as in range instead of flagging it', () => {
    expect(run([[t0, Number.NaN], [t0 + DRIFT_SUSTAIN_MS, Number.NaN]]).desync).toBe(false)
  })
})
