import { app, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { appDataDir } from '../shared/paths'
import * as Sentry from '@sentry/electron/main'
import { MAX_USER_REPORT_LENGTH, SENTRY_DSN, TELEMETRY_INSTALL_ID_PATTERN, sanitizeTelemetryEvent } from '../shared/telemetry'
import { redactTelemetryText } from '../shared/telemetry'
import { RECORDER_WARNING_CODES, type ChildDiagnostic } from '../shared/child-diagnostics'

let allowed = false
let started = false
let installId: string | undefined
let installIdFile: string | undefined

function loadInstallId(file: string): string | undefined {
  try {
    try {
      const id = readFileSync(file, 'utf8')
      if (TELEMETRY_INSTALL_ID_PATTERN.test(id)) return id
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined
    }
    const id = randomUUID()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, id, 'utf8')
    return id
  } catch { return undefined }
}

function sanitizeMainEvent<T extends Sentry.Event>(event: T): T | null {
  // Renderer events have their own user object; add the local ID at the final privacy boundary.
  return allowed ? sanitizeTelemetryEvent({ ...event, user: { id: installId } }) : null
}

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

/** Known recorder faults whose message text changed between versions or carries counters; one canonical title and category each. */
const KNOWN_FAULTS: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/Audio timestamp gap exceeds five seconds/i, 'audio_timestamp_gap', 'Audio timestamp gap exceeds five seconds'],
  [/processed no frames for over five seconds/i, 'encoder_stalled', 'Encoder has processed no frames for over five seconds'],
  [/queue remained full|muxer queue is full/i, 'muxer_queue_full', 'Muxer queue remained full']
]

/** Process exits caused by someone else ending it (Task Manager, debugger, Ctrl+C/console close), not by a fault in our code. */
const EXTERNAL_TERMINATION_EXIT_CODES = new Set([0x40010004, 0xC000013A])

export interface StableDiagnostic {
  /** Grouping key: stable across counters, addresses, paths, stderr text and UI language. */
  category: string
  /** Event title: the category's canonical sentence, or the message with volatile values removed. */
  title: string
  /** Recorder pipeline stage, when the message names one. */
  stage?: string
}

/** Remove everything that changes between occurrences of the same fault so Sentry groups them together. */
export function stableDiagnostic(message: string): StableDiagnostic {
  const stage = message.match(/\bstage=([a-z_]{1,32})\b/)?.[1]
  for (const [pattern, category, title] of KNOWN_FAULTS) if (pattern.test(message)) return { category, title, stage }
  message = message.replace(/^(?:encode_failed:\s*)?Audio input pts=[^;]*;[^:]*:\s*/, '')
  const title = redactTelemetryText(message.split(/[;\r\n]/)[0])
    // The text after the exit code is the process's stderr tail: different on every crash.
    .replace(/\(exit code (-?\d+|signal)[\s\S]*$/, '(exit code $1)')
    .replace(/\b\w+=\S+/g, '')
    .replace(/\b0x[0-9a-f]+\b/gi, 'N')
    .replace(/(exit code (?:-?\d+|signal))|\d+/g, (_match, exit: string | undefined) => exit ?? 'N')
    .replace(/\s+/g, ' ').trim().slice(0, 120)
  return { category: title, title, stage }
}

/** Exit code carried by a process-exit diagnostic, from the recorder's exit_code tag or the engine's message. */
function diagnosticExitCode(diagnostic: ChildDiagnostic): number | undefined {
  const tag = diagnostic.tags?.exit_code
  if (tag && /^0x[0-9A-F]{8}$/.test(tag)) return Number.parseInt(tag.slice(2), 16)
  const text = diagnostic.message.match(/exit code (-?\d+)/)?.[1]
  return text === undefined ? undefined : Number(text) >>> 0
}

export function isExternalTermination(diagnostic: ChildDiagnostic): boolean {
  if (diagnostic.code !== 'engine_crashed' && diagnostic.code !== 'recorder_crashed') return false
  const exitCode = diagnosticExitCode(diagnostic)
  return exitCode !== undefined && EXTERNAL_TERMINATION_EXIT_CODES.has(exitCode)
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
    stableDiagnostic(diagnostic.message).category
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
  ipcMain.handle('telemetry:report', (_event, message: unknown) => reportUserFeedback(message))
  ipcMain.handle('telemetry:playbackDesync', (_event, report: unknown) => reportPlaybackDesync(report))
  installIdFile = join(appDataDir(), 'telemetry-install-id')
  if (!consent) {
    updateTelemetryConsent(false)
    return
  }
  installId = loadInstallId(installIdFile)
  try {
    Sentry.init({
      dsn: SENTRY_DSN,
      release: `aditor@${app.getVersion()}`,
      environment: app.isPackaged ? 'production' : 'development',
      ipcMode: Sentry.IPCMode.Protocol,
      defaultIntegrations: false,
      integrations: [Sentry.onUncaughtExceptionIntegration(), Sentry.onUnhandledRejectionIntegration(),
        Sentry.normalizePathsIntegration(), Sentry.startupTracingIntegration(),
        // OS/CPU/memory and GPU; sanitizeTelemetryEvent allowlists the coarse fields that may leave the machine.
        Sentry.nodeContextIntegration({ app: false, culture: false, cloudResource: false }),
        Sentry.gpuContextIntegration({ infoLevel: 'complete' })],
      dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
      sendDefaultPii: false,
      tracesSampleRate: app.isPackaged ? 0.1 : 1,
      traceLifecycle: 'static',
      enableLogs: false,
      beforeSendMetric: () => null,
      sendClientReports: false,
      beforeBreadcrumb: () => null,
      beforeSend: sanitizeMainEvent,
      beforeSendTransaction: sanitizeMainEvent,
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
export function updateTelemetryConsent(consent: boolean): void {
  allowed = consent && started
  if (!consent) {
    installId = undefined
    try { if (installIdFile) unlinkSync(installIdFile) } catch { /* Deletion must not interrupt opt-out. */ }
  }
}

/** Explicit user action: send free text through the same sanitizer and device context as automatic errors. */
export function reportUserFeedback(message: unknown): boolean {
  if (!allowed || !started || typeof message !== 'string') return false
  const text = message.trim().slice(0, MAX_USER_REPORT_LENGTH)
  if (!text) return false
  try {
    return Boolean(Sentry.captureEvent({ message: text, level: 'info', tags: { component: 'user-report' } }))
  } catch { return false }
}

/** A few per session is enough to see the pattern; a stuck player must not flood Sentry. */
const MAX_DESYNC_REPORTS_PER_SESSION = 3
let desyncReports = 0

/** Preview audio/video drift measured by the renderer; versions come from main so they cannot be spoofed or mistyped. */
export function reportPlaybackDesync(raw: unknown): boolean {
  if (!allowed || !started || desyncReports >= MAX_DESYNC_REPORTS_PER_SESSION || !raw || typeof raw !== 'object') return false
  const r = raw as Record<string, unknown>
  const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(Math.round(value), 1e9)) : 0
  const driftMs = count(r.driftMs)
  if (driftMs === 0) return false
  // Software decoding is applied at startup through this Chromium switch (see main/index.ts).
  const decode = app.commandLine.hasSwitch('disable-accelerated-video-decode') ? 'software' : 'auto'
  try {
    const eventId = Sentry.captureEvent({
      level: 'warning',
      message: `Preview audio/video desync: drift ${driftMs}ms, dropped ${count(r.droppedFrames)}/${count(r.totalFrames)} frames, chrome ${process.versions.chrome ?? 'unknown'}`,
      fingerprint: ['preview-av-desync'],
      tags: { component: 'preview-playback', electron: process.versions.electron ?? '', decode }
    })
    if (!eventId) return false
    desyncReports += 1
    return true
  } catch { return false }
}

/** Child processes have no Sentry credentials or network client; this is their only upload path. */
export function reportChildDiagnostic(diagnostic: ChildDiagnostic): string | undefined {
  const warning = diagnostic.component === 'rust-recorder' && RECORDER_WARNING_CODES.has(diagnostic.code)
  if (!allowed || !started || (!REPORTABLE_CODES.has(diagnostic.code) && !warning)) return
  // Killed from outside (Task Manager, debugger, console close): not a fault we can fix, and it would only add noise.
  if (isExternalTermination(diagnostic)) return
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

    // Sentry groups by title when no fingerprint is set, so counters and stderr in the message split one fault into many issues.
    const stable = stableDiagnostic(diagnostic.message)
    const eventId = Sentry.captureEvent({
      platform: 'native', level: warning ? 'warning' : 'error',
      fingerprint: [diagnostic.component, diagnostic.code, stable.category, ...(exceptionType ? [exceptionType] : [])],
      tags: { ...diagnostic.tags, ...(stable.stage ? { stage: stable.stage } : {}), component: diagnostic.component },
      extra: { detail: redactTelemetryText(diagnostic.message) },
      exception: { values: [{ type: `${diagnostic.component}:${diagnostic.code}${exceptionType ? `:${exceptionType}` : ''}`,
        value: stable.title,
        mechanism: { type: 'child_process', handled: true },
        ...(frames.length ? { stacktrace: { frames } } : {}) }] }
    })
    if (!eventId) return
    rememberChildError(fingerprint, now)
    recentChildReportTimes.push(now)
    return eventId
  } catch { return undefined }
}
