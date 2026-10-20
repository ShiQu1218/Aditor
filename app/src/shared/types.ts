export type EventType = 'knock' | 'assist_knock' | 'assist_elim' | 'elim' | 'squad_wipe'

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
  /**
   * App-specific fields (unknown to the engine and discarded when `analyze` rewrites the file; main restores them after reanalysis).
   * `suggestionsPending`: AI suggestions have not yet been recomputed after reanalysis; run one merge when Studio opens, then clear this flag.
   */
  app?: { suggestionsPending?: boolean }
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
