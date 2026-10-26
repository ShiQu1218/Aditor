import type { Event, StackFrame } from '@sentry/electron/main'

// Public ingest key, not an auth token. Upload credentials belong only in the build environment.
export const SENTRY_DSN = 'https://5c57897479340b1a622630935c43a4fb@o4512296943747072.ingest.us.sentry.io/4512296977760256'

/** Matches the 500-character cap redactTelemetryText applies, so nothing is silently cut after the user submits. */
export const MAX_USER_REPORT_LENGTH = 500

/** Measurements only; main adds the Electron/Chrome versions and decode mode, and builds the event. */
export interface PlaybackDesyncReport {
  driftMs: number
  droppedFrames: number
  totalFrames: number
}

export function redactTelemetryText(value: string): string {
  return value
    .replace(/(?:file:\/\/\/|[A-Za-z]:[\\/]|\\\\)[^\r\n"'<>]+/g, '[local path]')
    .replace(/\/(?:Users|home|tmp|var)\/[^\r\n"'<>]+/g, '[local path]')
    .replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/g, '[email]')
    .replace(/https?:\/\/[^\s"'<>]+/g, '[url]')
    .replace(/\b(?:bearer\s+\S+|(?:password|token|secret|authorization|api[_-]?key)\s*[:=]\s*\S+)/gi, '[credential]')
    .slice(0, 500)
}

function safeFilename(value: string | undefined): string {
  const filename = value?.replace(/\\/g, '/')
  // Retain build-relative names for source-map matching, never absolute user paths or source context.
  const relative = filename?.match(/(?:app:\/\/\/|\/)(out\/(?:main|renderer|preload)\/[^?#]+)$/)?.[1]
  if (filename && /^aditor\/(?:[\w-]+\/)*[\w-]+\.py$/.test(filename)) return filename
  return relative ? `app:///${relative}` : filename?.startsWith('node:') ? filename : '[external]'
}

function safeFrame(frame: StackFrame): StackFrame {
  const filename = safeFilename(frame.filename)
  return {
    filename,
    // Sentry matches debug images against abs_path; use the same privacy-safe path for both.
    abs_path: filename,
    function: frame.function ? redactTelemetryText(frame.function) : undefined,
    lineno: frame.lineno, colno: frame.colno, in_app: filename.startsWith('app:///') || filename.startsWith('aditor/')
  }
}

// @sentry/electron's handleEnvelope only recognizes renderer pageload transactions by this exact
// SDK-generated origin, and the startup integration merges their spans into the launch trace.
// Keep only fixed SDK values: never forward app-provided or arbitrary origin strings.
const SAFE_TRACE_ORIGINS = new Set(['auto.pageload.browser', 'auto.navigation.browser', 'auto.electron.startup'])

// Coarse hardware facts only: no hostnames, boot times, locale or free-form build strings.
const GPU_FIELDS = ['name', 'vendor_name', 'driver_version', 'id', 'vendor_id', 'active'] as const
// The SDK names a single adapter `gpu` but several `gpu_1`, `gpu_2`, ... (laptops and iGPU + dGPU desktops).
const MAX_GPU_CONTEXTS = 4
const HARDWARE_CONTEXT_FIELDS: Record<string, readonly string[]> = {
  os: ['name', 'version', 'kernel_version'],
  device: ['arch', 'memory_size', 'processor_count', 'cpu_description', 'processor_frequency'],
  gpu: GPU_FIELDS,
  ...Object.fromEntries(Array.from({ length: MAX_GPU_CONTEXTS }, (_, i) => [`gpu_${i + 1}`, GPU_FIELDS]))
}

function safeHardwareContexts(contexts: Event['contexts']): Record<string, Record<string, string | number | boolean>> {
  const out: Record<string, Record<string, string | number | boolean>> = {}
  for (const [key, fields] of Object.entries(HARDWARE_CONTEXT_FIELDS)) {
    const source = contexts?.[key] as Record<string, unknown> | undefined
    const picked: Record<string, string | number | boolean> = {}
    for (const field of fields) {
      const value = source?.[field]
      if (typeof value === 'number' || typeof value === 'boolean') picked[field] = value
      else if (typeof value === 'string') picked[field] = redactTelemetryText(value)
    }
    if (Object.keys(picked).length) out[key] = picked
  }
  return out
}

const SAFE_COMPONENTS = new Set(['python-engine', 'python-live', 'rust-recorder', 'user-report', 'preview-playback'])
// Extra tags are kept only when their value has a fixed, non-identifying shape.
const SAFE_TAG_VALUES: Record<string, RegExp> = {
  electron: /^\d+(?:\.\d+){2}$/,
  decode: /^(?:auto|software)$/,
  // Recorder state at failure time (see recorderTags in aditorrec-client.ts).
  capture: /^(?:wgc|dda|hook)$/,
  codec: /^(?:hevc|h264|av1)$/,
  encoder: /^[\w.-]{1,32}$/,
  fps: /^\d{1,4}$/,
  height: /^\d{1,5}$/,
  mic: /^(?:on|off)$/,
  system_audio: /^(?:on|off)$/,
  phase: /^(?:startup|recording)$/,
  uptime: /^(?:<10s|<1m|<10m|<1h|>=1h)$/
}

function safeTags(tags: Event['tags']): Record<string, string> | undefined {
  if (typeof tags?.component !== 'string' || !SAFE_COMPONENTS.has(tags.component)) return undefined
  const out: Record<string, string> = { component: tags.component }
  for (const [key, pattern] of Object.entries(SAFE_TAG_VALUES)) {
    const value = tags[key]
    if (typeof value === 'string' && pattern.test(value)) out[key] = value
  }
  return out
}

/** Allowlist payload fields rather than trying to blacklist arbitrary app/SDK context. */
export function sanitizeTelemetryEvent<T extends Event>(event: T): T {
  const traceOrigin = event.contexts?.trace?.origin
  const safeOrigin = traceOrigin && SAFE_TRACE_ORIGINS.has(traceOrigin) ? traceOrigin : undefined
  return {
    event_id: event.event_id, timestamp: event.timestamp, type: event.type,
    platform: event.platform, level: event.level, release: event.release,
    environment: event.environment,
    sdk: { ...event.sdk, settings: { infer_ip: 'never' } },
    // Explicit sentinel prevents server-side enrichment from the network IP.
    user: { ip_address: '0.0.0.0' },
    tags: safeTags(event.tags),
    // Only our own reporters set a fingerprint; it groups repeated reports of one fault into one issue.
    fingerprint: event.fingerprint?.filter((part) => typeof part === 'string').slice(0, 5),
    debug_meta: event.debug_meta ? { images: event.debug_meta.images?.flatMap((image) =>
      image.type === 'sourcemap' && safeFilename(image.code_file) !== '[external]'
        ? [{ type: 'sourcemap' as const, code_file: safeFilename(image.code_file), debug_id: image.debug_id }] : []) } : undefined,
    message: event.message ? redactTelemetryText(event.message) : undefined,
    exception: event.exception ? { values: event.exception.values?.map((value) => ({
      type: value.type ? redactTelemetryText(value.type) : undefined, value: value.value ? redactTelemetryText(value.value) : undefined,
      mechanism: value.mechanism ? { type: value.mechanism.type, handled: value.mechanism.handled } : undefined,
      stacktrace: value.stacktrace ? { frames: value.stacktrace.frames?.map(safeFrame) } : undefined
    })) } : undefined,
    contexts: event.contexts ? {
      ...safeHardwareContexts(event.contexts),
      ...(event.contexts.trace ? { trace: {
        trace_id: event.contexts.trace.trace_id, span_id: event.contexts.trace.span_id,
        parent_span_id: event.contexts.trace.parent_span_id,
        ...(safeOrigin ? { origin: safeOrigin } : {}), op: 'desktop'
      } } : {})
    } : undefined,
    ...(event.type === 'transaction' ? {
      transaction: 'Aditor desktop', start_timestamp: event.start_timestamp,
      spans: event.spans?.map((span) => ({
        trace_id: span.trace_id, span_id: span.span_id, parent_span_id: span.parent_span_id,
        start_timestamp: span.start_timestamp, timestamp: span.timestamp,
        op: 'desktop', description: 'Desktop operation', data: {}
      }))
    } : {})
  } as T
}
