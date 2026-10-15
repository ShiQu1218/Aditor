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
  /** 缺省（舊檔）視為 'accepted' */
  status?: ClipStatus
  /** 重新分析後保留的 AI 片段，來源事件可能已變 */
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
  profile: string
  analysis: AnalysisInfo
  events: EngineEvent[]
  spectating: SpecInterval[]
  clips: Clip[]
  keyframes: number[]
  cache_path: string
  /**
   * App 專屬欄位（引擎不認得，下次 analyze 重寫文件時會被丟棄，由 main 在重新分析後補回）。
   * `suggestionsPending`：重新分析後 AI 建議尚未重算；工作室開啟時執行一次 merge 並清除。
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
