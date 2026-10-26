/** A/V drift above this (seconds) is far beyond normal frame/compositor latency (~0.1 s). */
export const DRIFT_THRESHOLD_S = 0.25
/** Drift must persist this long without a single in-range sample, so one late frame never triggers a report. */
export const DRIFT_SUSTAIN_MS = 3000
/** Ignore samples right after play, seek, stall or rate change while the audio clock and frames re-align. */
export const SETTLE_MS = 2000

export interface SyncState {
  readonly settleUntilMs: number
  readonly breachSinceMs: number | null
  readonly worstDriftS: number
}

export function settle(nowMs: number): SyncState {
  return { settleUntilMs: nowMs + SETTLE_MS, breachSinceMs: null, worstDriftS: 0 }
}

/** One frame sample: driftS = video.currentTime (audio clock) - presented frame mediaTime. */
export function stepSync(state: SyncState, nowMs: number, driftS: number): { state: SyncState; desync: boolean } {
  if (nowMs < state.settleUntilMs) return { state, desync: false }
  const drift = Math.abs(driftS)
  if (!(drift >= DRIFT_THRESHOLD_S)) return { state: { ...state, breachSinceMs: null, worstDriftS: 0 }, desync: false }
  const since = state.breachSinceMs ?? nowMs
  return {
    state: { ...state, breachSinceMs: since, worstDriftS: Math.max(state.worstDriftS, drift) },
    desync: nowMs - since >= DRIFT_SUSTAIN_MS
  }
}
