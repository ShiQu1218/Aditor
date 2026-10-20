import type { GameId } from './games'

/** Apex: knock/assist_knock/assist_elim (elim/squad_wipe only in older or manual data). Valorant: kill/death/multikill/ace. */
export type EventType = 'knock' | 'assist_knock' | 'assist_elim' | 'elim' | 'squad_wipe' | 'kill' | 'death' | 'multikill' | 'ace'

/** Library badge counts; kill/death are absent for Apex and in entries written before multi-game support. */
export interface EventCounts {
  knock: number
  assist: number
  kill?: number
  death?: number
}

/** A Valorant round from the Riot client presence or the scoreboard; `ally`/`enemy` are the score after the round. */
export interface Round {
  start: number
  end: number
  winner: 'ally' | 'enemy' | null
  ally: number
  enemy: number
}

export interface VideoInfo {
  path: string
  size: number
  mtime: number
  duration: number
  width: number
  height: number
  codec: string
  start_time: number
  /** Average frame rate from the engine probe; absent in caches written before it was probed. */
  fps?: number
  pix_fmt?: string
}

export interface EngineEvent {
  id: string
  t: number
  type: EventType | string
  score: number
  damage_line: boolean
  name_sig: string | null
  counted: boolean
  counted_reason: string
  counted_override: boolean | null
  source: 'auto' | 'manual'
  deleted?: boolean
}

export interface SpecInterval {
  start: number
  end: number
}

export type ClipStatus = 'suggested' | 'accepted' | 'skipped'

export interface Clip {
  id: string
  start: number
  end: number
  origin: 'ai' | 'manual'
  event_ids: string[]
  /** Defaults to 'accepted' for older files. */
  status?: ClipStatus
  /** AI clip retained after reanalysis; its source events may have changed. */
  stale?: boolean
}

export interface AutoClipParams {
  gap: number
  n: number
  before: number
  after: number
  max_len: number
}

export interface AnalysisInfo {
  status: 'done' | 'partial'
  progress_t: number
  engine_version: string
  templates_version: string
  h_scale: number
}

export interface CacheDoc {
  version: number
  video: VideoInfo
  /** Language in older caches (no longer written by engine since 0.3.0). */
  profile?: string | null
  analysis: AnalysisInfo
  events: EngineEvent[]
  spectating: SpecInterval[]
  clips: Clip[]
  keyframes: number[]
  cache_path: string
  /** Absent in caches written before multi-game support (Apex). */
  game?: GameId
  rounds?: Round[]
  /**
   * App-specific fields (unknown to the engine and discarded when `analyze` rewrites the file; main restores them after reanalysis).
   * `suggestionsPending`: AI suggestions have not yet been recomputed after reanalysis; run one merge when Studio opens, then clear this flag.
   */
  app?: { suggestionsPending?: boolean }
}

export function countEvents(events: readonly EngineEvent[]): EventCounts {
  const counts: EventCounts = { knock: 0, assist: 0 }
  for (const e of events) {
    if (!isCounted(e)) continue
    if (e.type === 'knock') counts.knock++
    else if (e.type === 'assist_knock' || e.type === 'assist_elim') counts.assist++
    else if (e.type === 'kill') counts.kill = (counts.kill ?? 0) + 1
    else if (e.type === 'death') counts.death = (counts.death ?? 0) + 1
  }
  return counts
}

export function isCounted(e: EngineEvent): boolean {
  if (e.deleted) {
    return false
  }
  if (e.counted_override !== null && e.counted_override !== undefined) {
    return Boolean(e.counted_override)
  }
  return Boolean(e.counted)
}
