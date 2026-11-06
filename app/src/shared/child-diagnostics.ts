export type DiagnosticComponent = 'rust-engine' | 'rust-live' | 'rust-recorder' | 'recording-service'

export const RECORDING_SERVICE_ERRORS = {
  game_query_failed: 'Game process query failed',
  recording_start_failed: 'Recording setup failed',
  obs_start_failed: 'OBS recording start failed',
  obs_match_failed: 'OBS match recording failed',
  obs_import_failed: 'OBS match import failed',
  clip_failed: 'Match clipping failed',
  finalize_failed: 'Recording finalization failed',
  recovery_failed: 'Recording recovery failed'
} as const

export const RECORDER_WARNING_CODES = new Set([
  'audio_device_missing', 'audio_source_lost', 'audio_capture_stalled', 'game_audio_unavailable', 'encoder_stalled'
])

export interface ChildDiagnostic {
  component: DiagnosticComponent
  code: string
  message: string
  exception?: unknown
  /** Coarse state at failure time; the telemetry sanitizer re-validates every value against an allowlist. */
  tags?: Readonly<Record<string, string>>
}

export type ChildDiagnosticHandler = (diagnostic: ChildDiagnostic) => void

/** Diagnostics cannot interrupt analysis, recording, or process cleanup. */
export function emitChildDiagnostic(handler: ChildDiagnosticHandler | undefined, diagnostic: ChildDiagnostic): void {
  try { handler?.(diagnostic) } catch { /* Optional monitoring must not affect the operation. */ }
}
