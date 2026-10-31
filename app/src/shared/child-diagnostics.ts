export type DiagnosticComponent = 'rust-engine' | 'rust-live' | 'rust-recorder'

export const RECORDER_AUDIO_WARNING_CODES = new Set([
  'audio_device_missing', 'audio_source_lost', 'audio_capture_stalled', 'game_audio_unavailable'
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
