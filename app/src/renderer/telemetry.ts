import { sanitizeTelemetryEvent } from '../shared/telemetry'

export async function initializeRendererTelemetry(): Promise<void> {
  try {
    if (!await window.api?.telemetry?.enabled()) return
    const Sentry = await import('@sentry/electron/renderer')
    Sentry.init({
      integrations: (defaults) => [...defaults.filter((item) => ['GlobalHandlers', 'TryCatch', 'BrowserApiErrors', 'InboundFilters', 'EventFilters', 'ScopeToMain'].includes(item.name)), Sentry.browserTracingIntegration()],
      dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
      tracesSampleRate: 0.1,
      traceLifecycle: 'static',
      enableLogs: false,
      beforeSendMetric: () => null,
      sendClientReports: false,
      beforeBreadcrumb: () => null,
      beforeSend: sanitizeTelemetryEvent,
      beforeSendTransaction: (event) => sanitizeTelemetryEvent(event) as typeof event
    })
  } catch { /* Reporting is optional; the UI must still start. */ }
}
