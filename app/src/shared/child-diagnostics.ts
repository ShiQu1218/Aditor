export type DiagnosticComponent = 'python-engine' | 'python-live' | 'rust-recorder'

export interface ChildDiagnostic {
  component: DiagnosticComponent
  code: string
  message: string
  exception?: unknown
}

export type ChildDiagnosticHandler = (diagnostic: ChildDiagnostic) => void

/** Diagnostics cannot interrupt analysis, recording, or process cleanup. */
export function emitChildDiagnostic(handler: ChildDiagnosticHandler | undefined, diagnostic: ChildDiagnostic): void {
  try { handler?.(diagnostic) } catch { /* Optional monitoring must not affect the operation. */ }
}
