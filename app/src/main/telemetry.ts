import { app, ipcMain } from 'electron'
import * as Sentry from '@sentry/electron/main'
import { SENTRY_DSN, sanitizeTelemetryEvent } from '../shared/telemetry'
import { redactTelemetryText } from '../shared/telemetry'
import type { ChildDiagnostic } from '../shared/child-diagnostics'

let allowed = false
let started = false

/** Suppress the same fault for five minutes without collapsing distinct failures in one component/code. */
export const CHILD_DIAGNOSTIC_DEDUPE_WINDOW_MS = 5 * 60_000
/** Bound fingerprint history even if a child produces a large variety of failures. */
export const MAX_TRACKED_CHILD_DIAGNOSTICS = 100
/** Independent overall report budget across all components and fingerprints. */
export const CHILD_DIAGNOSTIC_RATE_WINDOW_MS = 5 * 60_000
export const MAX_CHILD_DIAGNOSTICS_PER_WINDOW = 20

const recentChildErrors = new Map<string, number>()
const recentChildReportTimes: number[] = []
const REPORTABLE_CODES = new Set(['internal', 'decode_failed', 'profile_error', 'engine_spawn', 'engine_crashed',
  'capture_failed', 'encode_failed', 'audio_failed', 'shm_open_failed', 'bad_reply', 'recorder_crashed', 'recorder_spawn', 'recorder_io', 'recorder_timeout'])

/** Normalize volatile values so the same fault keeps one fingerprint, then hash to retain no diagnostic text. */
function fingerprintText(value: string | undefined): string {
  if (!value) return ''
  return redactTelemetryText(value)
    .replace(/\b0x[0-9a-f]+\b/gi, '[address]')
    .replace(/\b[0-9a-f]{8,}\b/gi, '[id]')
    .replace(/\b\d+(?:[.,]\d+)*\b/g, '[number]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

function hashFingerprint(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function childErrorFingerprint(diagnostic: ChildDiagnostic, frames: Sentry.StackFrame[], exceptionType: string | undefined): string {
  const frame = frames[frames.length - 1]
  return hashFingerprint([
    diagnostic.component,
    diagnostic.code,
    fingerprintText(exceptionType),
    frame ? `${frame.filename}:${frame.function ?? ''}:${frame.lineno}` : '',
    fingerprintText(diagnostic.message)
  ].join('\u0000'))
}

function pruneChildErrors(now: number): void {
  for (const [fingerprint, reportedAt] of recentChildErrors) {
    if (now - reportedAt >= CHILD_DIAGNOSTIC_DEDUPE_WINDOW_MS) recentChildErrors.delete(fingerprint)
  }
}

function rememberChildError(fingerprint: string, now: number): void {
  // Reinsert so eviction always removes the least recently reported fingerprint.
  recentChildErrors.delete(fingerprint)
  recentChildErrors.set(fingerprint, now)
  while (recentChildErrors.size > MAX_TRACKED_CHILD_DIAGNOSTICS) {
    const oldest = recentChildErrors.keys().next().value
    if (oldest === undefined) break
    recentChildErrors.delete(oldest)
  }
}

function withinReportBudget(now: number): boolean {
  const cutoff = now - CHILD_DIAGNOSTIC_RATE_WINDOW_MS
  while (recentChildReportTimes.length > 0 && recentChildReportTimes[0] <= cutoff) recentChildReportTimes.shift()
  return recentChildReportTimes.length < MAX_CHILD_DIAGNOSTICS_PER_WINDOW
}

/** Called after userData is set and before app.ready; disabled installs never initialize the SDK. */
export function initializeTelemetry(consent: boolean): void {
  allowed = consent
  ipcMain.handle('telemetry:enabled', () => started && allowed)
  if (!consent) return
  try {
    Sentry.init({
      dsn: SENTRY_DSN,
      release: `aditor@${app.getVersion()}`,
      environment: app.isPackaged ? 'production' : 'development',
      ipcMode: Sentry.IPCMode.Protocol,
      defaultIntegrations: false,
      integrations: [Sentry.onUncaughtExceptionIntegration(), Sentry.onUnhandledRejectionIntegration(),
        Sentry.normalizePathsIntegration(), Sentry.startupTracingIntegration()],
      dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
      sendDefaultPii: false,
      tracesSampleRate: app.isPackaged ? 0.1 : 1,
      traceLifecycle: 'static',
      enableLogs: false,
      beforeSendMetric: () => null,
      sendClientReports: false,
      beforeBreadcrumb: () => null,
      beforeSend: (event) => allowed ? sanitizeTelemetryEvent(event) : null,
      beforeSendTransaction: (event) => allowed ? sanitizeTelemetryEvent(event) as typeof event : null,
      // Memory-only transport: no saved events to upload after consent is withdrawn.
      transport: (options) => {
        const transport = Sentry.makeElectronTransport(options)
        return {
          send: (envelope) => allowed ? transport.send(envelope) : Promise.resolve({}),
          flush: (timeout) => transport.flush(timeout)
        }
      }
    })
    started = true
  } catch {
    // Monitoring must never prevent the desktop app from starting.
    console.error('[Telemetry] initialization failed')
  }
}

/** Disabling takes effect immediately; enabling requires a restart to install startup hooks safely. */
export function updateTelemetryConsent(consent: boolean): void { allowed = consent && started }

/** Child processes have no Sentry credentials or network client; this is their only upload path. */
export function reportChildDiagnostic(diagnostic: ChildDiagnostic): string | undefined {
  if (!allowed || !started || !REPORTABLE_CODES.has(diagnostic.code)) return
  try {
    const now = Date.now()
    const detail = diagnostic.exception as { type?: unknown; frames?: unknown } | undefined
    const exceptionType = typeof detail?.type === 'string' ? redactTelemetryText(detail.type) : undefined
    const frames: Sentry.StackFrame[] = Array.isArray(detail?.frames) ? detail.frames.slice(-30).flatMap((raw) => {
      if (!raw || typeof raw !== 'object') return []
      const frame = raw as Record<string, unknown>
      if (typeof frame.filename !== 'string' || !/^aditor\/(?:[\w-]+\/)*[\w-]+\.py$/.test(frame.filename) ||
        typeof frame.lineno !== 'number' || !Number.isInteger(frame.lineno) || frame.lineno <= 0) return []
      return [{ filename: frame.filename, lineno: frame.lineno,
        function: typeof frame.function === 'string' ? redactTelemetryText(frame.function) : undefined, in_app: true }]
    }) : []

    pruneChildErrors(now)
    const fingerprint = childErrorFingerprint(diagnostic, frames, exceptionType)
    const reportedAt = recentChildErrors.get(fingerprint)
    if (reportedAt !== undefined && now - reportedAt < CHILD_DIAGNOSTIC_DEDUPE_WINDOW_MS) return
    if (!withinReportBudget(now)) return

    const eventId = Sentry.captureEvent({
      platform: diagnostic.component === 'rust-recorder' ? 'native' : 'python', level: 'error',
      tags: { component: diagnostic.component },
      exception: { values: [{ type: `${diagnostic.component}:${diagnostic.code}${exceptionType ? `:${exceptionType}` : ''}`,
        value: redactTelemetryText(diagnostic.message),
        mechanism: { type: 'child_process', handled: true },
        ...(frames.length ? { stacktrace: { frames } } : {}) }] }
    })
    if (!eventId) return
    rememberChildError(fingerprint, now)
    recentChildReportTimes.push(now)
    return eventId
  } catch { return undefined }
}
