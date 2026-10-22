import type { Event, StackFrame } from '@sentry/electron/main'

// Public ingest key, not an auth token. Upload credentials belong only in the build environment.
export const SENTRY_DSN = 'https://5c57897479340b1a622630935c43a4fb@o4512296943747072.ingest.us.sentry.io/4512296977760256'

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
    tags: typeof event.tags?.component === 'string' && ['python-engine', 'python-live', 'rust-recorder'].includes(event.tags.component)
      ? { component: event.tags.component } : undefined,
    debug_meta: event.debug_meta ? { images: event.debug_meta.images?.flatMap((image) =>
      image.type === 'sourcemap' && safeFilename(image.code_file) !== '[external]'
        ? [{ type: 'sourcemap' as const, code_file: safeFilename(image.code_file), debug_id: image.debug_id }] : []) } : undefined,
    message: event.message ? redactTelemetryText(event.message) : undefined,
    exception: event.exception ? { values: event.exception.values?.map((value) => ({
      type: value.type ? redactTelemetryText(value.type) : undefined, value: value.value ? redactTelemetryText(value.value) : undefined,
      mechanism: value.mechanism ? { type: value.mechanism.type, handled: value.mechanism.handled } : undefined,
      stacktrace: value.stacktrace ? { frames: value.stacktrace.frames?.map(safeFrame) } : undefined
    })) } : undefined,
    contexts: event.contexts?.trace ? { trace: {
      trace_id: event.contexts.trace.trace_id, span_id: event.contexts.trace.span_id,
      parent_span_id: event.contexts.trace.parent_span_id,
      ...(safeOrigin ? { origin: safeOrigin } : {}), op: 'desktop'
    } } : undefined,
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
