import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChildDiagnostic } from '../shared/child-diagnostics'

const fake = vi.hoisted(() => ({ init: vi.fn(), handle: vi.fn(), send: vi.fn(async () => ({})), captureEvent: vi.fn((event: any) => 'test-event') }))
vi.mock('electron', () => ({ app: { isPackaged: false, getVersion: () => '0.3.0' }, ipcMain: { handle: fake.handle } }))
vi.mock('@sentry/electron/main', () => ({
  init: fake.init, IPCMode: { Protocol: 2 },
  captureEvent: fake.captureEvent,
  onUncaughtExceptionIntegration: () => ({}), onUnhandledRejectionIntegration: () => ({}),
  normalizePathsIntegration: () => ({}), startupTracingIntegration: () => ({}),
  makeElectronTransport: () => ({ send: fake.send, flush: async () => true })
}))

function diagnostic(overrides: Partial<ChildDiagnostic> = {}): ChildDiagnostic {
  return {
    component: 'python-engine',
    code: 'internal',
    message: 'Cannot read C:\\Users\\Alice\\private.mp4',
    exception: {
      type: 'TypeError',
      frames: [{ filename: 'aditor/ipc.py', function: '_run', lineno: 150 }, { filename: 'C:/private.py', lineno: 1 }]
    },
    ...overrides
  }
}

beforeEach(() => { vi.resetModules(); vi.clearAllMocks() })
afterEach(() => { vi.useRealTimers() })

describe('telemetry consent', () => {
  it('does not initialize or enable reporting without persisted consent, even after toggling on', async () => {
    const { initializeTelemetry, updateTelemetryConsent } = await import('./telemetry')
    initializeTelemetry(false)
    updateTelemetryConsent(true)
    expect(fake.init).not.toHaveBeenCalled()
    expect(fake.handle.mock.calls[0][1]()).toBe(false)
  })

  it('blocks new events and queued transport sends immediately after consent withdrawal', async () => {
    const { initializeTelemetry, updateTelemetryConsent } = await import('./telemetry')
    initializeTelemetry(true)
    const options = fake.init.mock.calls[0][0]
    const transport = options.transport({})
    await transport.send([{}, []])
    expect(fake.send).toHaveBeenCalledTimes(1)
    updateTelemetryConsent(false)
    expect(fake.handle.mock.calls[0][1]()).toBe(false)
    expect(options.beforeSend({ message: 'test' })).toBeNull()
    expect(options.beforeSendTransaction({ type: 'transaction' })).toBeNull()
    await transport.send([{}, []])
    expect(fake.send).toHaveBeenCalledTimes(1)
    expect(options.defaultIntegrations).toBe(false)
    expect(options.enableLogs).toBe(false)
  })
})

describe('child diagnostics', () => {
  it('filters routine errors and sanitizes reportable failures', async () => {
    const { initializeTelemetry, reportChildDiagnostic } = await import('./telemetry')
    initializeTelemetry(true)
    reportChildDiagnostic({ component: 'rust-recorder', code: 'disk_full', message: 'Disk full' })
    reportChildDiagnostic({ component: 'python-engine', code: 'cancelled', message: 'Cancelled' })
    expect(fake.captureEvent).not.toHaveBeenCalled()

    expect(reportChildDiagnostic(diagnostic())).toBe('test-event')
    const event = fake.captureEvent.mock.calls[0][0]
    expect(event.platform).toBe('python')
    expect(event.exception.values[0].type).toBe('python-engine:internal:TypeError')
    expect(event.exception.values[0].stacktrace.frames).toEqual([{ filename: 'aditor/ipc.py', function: '_run', lineno: 150, in_app: true }])
    expect(JSON.stringify(event)).not.toContain('Alice')
  })

  it('suppresses an identical failure but reports different failures sharing component and code', async () => {
    const { initializeTelemetry, reportChildDiagnostic } = await import('./telemetry')
    initializeTelemetry(true)
    const repeated = diagnostic({ message: 'Cannot read "C:\\Users\\Alice\\private.mp4" (attempt 1)' })
    expect(reportChildDiagnostic(repeated)).toBe('test-event')
    expect(reportChildDiagnostic(repeated)).toBeUndefined()
    // Volatile paths and numbers must not turn one recurring fault into many reports.
    expect(reportChildDiagnostic(diagnostic({ message: 'Cannot read "C:\\Users\\Bob\\other.mp4" (attempt 2)' }))).toBeUndefined()

    expect(reportChildDiagnostic(diagnostic({
      message: 'Memory exhausted',
      exception: { type: 'MemoryError', frames: [{ filename: 'aditor/ipc.py', function: '_run', lineno: 150 }] }
    }))).toBe('test-event')
    expect(reportChildDiagnostic(diagnostic({
      message: 'Cannot read C:\\Users\\Alice\\private.mp4',
      exception: { type: 'TypeError', frames: [{ filename: 'aditor/other.py', function: 'other', lineno: 20 }] }
    }))).toBe('test-event')
    expect(fake.captureEvent).toHaveBeenCalledTimes(3)
  })

  it('allows the same failure again after the dedupe window', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const { initializeTelemetry, reportChildDiagnostic, CHILD_DIAGNOSTIC_DEDUPE_WINDOW_MS } = await import('./telemetry')
    initializeTelemetry(true)
    const repeated = diagnostic()
    expect(reportChildDiagnostic(repeated)).toBe('test-event')

    vi.setSystemTime(Date.now() + CHILD_DIAGNOSTIC_DEDUPE_WINDOW_MS - 1)
    expect(reportChildDiagnostic(repeated)).toBeUndefined()
    expect(fake.captureEvent).toHaveBeenCalledTimes(1)

    vi.setSystemTime(Date.now() + 1)
    expect(reportChildDiagnostic(repeated)).toBe('test-event')
    expect(fake.captureEvent).toHaveBeenCalledTimes(2)
  })

  it('enforces an independent total report budget and resets it after the window', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const {
      initializeTelemetry, reportChildDiagnostic, MAX_CHILD_DIAGNOSTICS_PER_WINDOW, CHILD_DIAGNOSTIC_RATE_WINDOW_MS
    } = await import('./telemetry')
    initializeTelemetry(true)

    for (let index = 0; index < MAX_CHILD_DIAGNOSTICS_PER_WINDOW; index += 1) {
      expect(reportChildDiagnostic(diagnostic({
        message: `distinct failure ${index}`,
        exception: { type: `Error${index}`, frames: [{ filename: 'aditor/ipc.py', function: '_run', lineno: index + 1 }] }
      }))).toBe('test-event')
    }
    expect(fake.captureEvent).toHaveBeenCalledTimes(MAX_CHILD_DIAGNOSTICS_PER_WINDOW)
    expect(reportChildDiagnostic(diagnostic({
      message: 'over budget', exception: { type: 'OverBudget', frames: [{ filename: 'aditor/ipc.py', function: '_run', lineno: 999 }] }
    }))).toBeUndefined()
    expect(fake.captureEvent).toHaveBeenCalledTimes(MAX_CHILD_DIAGNOSTICS_PER_WINDOW)

    vi.setSystemTime(Date.now() + CHILD_DIAGNOSTIC_RATE_WINDOW_MS)
    expect(reportChildDiagnostic(diagnostic({
      message: 'after budget window', exception: { type: 'AfterWindow', frames: [{ filename: 'aditor/ipc.py', function: '_run', lineno: 1000 }] }
    }))).toBe('test-event')
    expect(fake.captureEvent).toHaveBeenCalledTimes(MAX_CHILD_DIAGNOSTICS_PER_WINDOW + 1)
  })

  it('does not report while disabled or after consent is withdrawn', async () => {
    const { initializeTelemetry, reportChildDiagnostic, updateTelemetryConsent } = await import('./telemetry')
    initializeTelemetry(false)
    expect(reportChildDiagnostic(diagnostic())).toBeUndefined()
    updateTelemetryConsent(true)
    expect(reportChildDiagnostic(diagnostic())).toBeUndefined()
    expect(fake.captureEvent).not.toHaveBeenCalled()

    initializeTelemetry(true)
    expect(reportChildDiagnostic(diagnostic())).toBe('test-event')
    updateTelemetryConsent(false)
    expect(reportChildDiagnostic(diagnostic({ message: 'another failure' }))).toBeUndefined()
    expect(fake.captureEvent).toHaveBeenCalledTimes(1)
  })
})
