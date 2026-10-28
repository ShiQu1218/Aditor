import * as Sentry from '@sentry/electron/main'
import { resolve } from 'path'
import { reportChildDiagnostic } from './telemetry'
import type { ChildDiagnostic } from '../shared/child-diagnostics'

/** Explicit development/E2E check, never called by packaged builds or normal launches. */
export async function verifyTelemetry(): Promise<{ eventId: string; message: string; flushed: boolean; debugImageCount: number; childEventIds: Record<string, string> }> {
  if (!Sentry.isEnabled()) throw new Error('Telemetry verification requires explicit consent')
  const message = `Aditor source map verification ${new Date().toISOString()}`
  let debugImageCount = 0
  const unsubscribe = Sentry.getClient()?.on('beforeSendEvent', (event) => {
    if (event.exception?.values?.some((value) => value.value === message)) {
      debugImageCount = event.debug_meta?.images?.filter((image) => image.type === 'sourcemap').length ?? 0
    }
  })
  let eventId = ''
  Sentry.startSpan({ name: 'Desktop verification', op: 'desktop.verify', forceTransaction: true }, () => {
    try {
      throw new Error(message)
    } catch (error) {
      eventId = Sentry.captureException(error)
    }
  })
  const childEventIds: Record<string, string> = {}
  if (process.env.ADITOR_SENTRY_VERIFY_CHILDREN === '1') {
    const onDiagnostic = (diagnostic: ChildDiagnostic): void => {
      const id = reportChildDiagnostic(diagnostic)
      if (id) childEventIds[diagnostic.component] = id
    }
    const { EngineClient } = await import('./engine')
    const engineCommand = process.env.ADITOR_VERIFY_ENGINE
    const recorderCommand = process.env.ADITOR_VERIFY_RECORDER
    if (!engineCommand || !recorderCommand) throw new Error('Child verification requires explicit analysis engine and recorder executables')
    const engine = new EngineClient({ command: engineCommand, args: ['ipc'], onDiagnostic })
    try {
      await engine.start()
      // Exercise a reportable profile failure without opening or analyzing a video.
      await engine.request('derive', { events: [], spectating: [],
        profile_dir: resolve(process.env.ADITOR_APPDATA!, 'missing-verification-profile') }).promise.catch(() => undefined)
    } finally { await engine.stop() }
    const { LiveEngine } = await import('./recording/live-engine')
    let resolveLive!: () => void
    const liveReported = new Promise<void>((resolve) => { resolveLive = resolve })
    const live = new LiveEngine({ command: { command: engineCommand, args: ['live'] },
      args: ['--shm', 'Local\\aditor-sentry-verification', '--profile-dir', resolve(process.env.ADITOR_APPDATA!, 'missing-verification-profile')],
      onDiagnostic: (diagnostic) => { onDiagnostic(diagnostic); if (diagnostic.code === 'internal') resolveLive() } })
    let liveTimer: ReturnType<typeof setTimeout> | undefined
    try {
      live.start()
      await Promise.race([liveReported, new Promise<never>((_, reject) => {
        liveTimer = setTimeout(() => reject(new Error('Live engine verification timed out')), 10_000)
      })])
    } finally { clearTimeout(liveTimer); await live.stop() }
    const { AditorrecClient } = await import('./recording/aditorrec-client')
    const recorder = new AditorrecClient({ command: recorderCommand, args: [] }, onDiagnostic)
    try {
      await recorder.hello()
      // No recording is started. Terminate only this isolated helper to verify crash reporting.
      const crashed = new Promise<void>((resolve) => recorder.once('crash', () => resolve()))
      if (!recorder.pid) throw new Error('Recorder verification did not start')
      process.kill(recorder.pid)
      await crashed
    } finally { await recorder.close() }
    if (!childEventIds['rust-engine'] || !childEventIds['rust-live'] || !childEventIds['rust-recorder']) throw new Error('Child diagnostics did not reach the gateway')
  }
  const flushed = await Sentry.flush(10_000)
  unsubscribe?.()
  return { eventId, message, flushed, debugImageCount, childEventIds }
}
