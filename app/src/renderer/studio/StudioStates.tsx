import { i18n } from '../i18n'

/** Full-page states before studio loading, when blocked, or after load failure (never show fabricated data). */
export function StudioLoadingView(): JSX.Element {
  return (
    <div className="studio-blocked" role="status">
      <p>{i18n.studio.loading}</p>
    </div>
  )
}

export function StudioBlockedView({ onBack }: { onBack: () => void }): JSX.Element {
  return (
    <div className="studio-blocked" role="alert">
      <p>{i18n.studio.openBlocked}</p>
      <button type="button" className="btn-ghost" onClick={onBack}>
        {i18n.studio.back}
      </button>
    </div>
  )
}

interface LoadErrorViewProps {
  code?: string | number
/** Underlying failure reason (engine/IPC message), shown so the user sees why loading failed. */
  message?: string
  onRetry: () => void
  onCopy: () => void
  onBack: () => void
}

/** Load failure: error code plus Retry, Copy Error, and Back to Library actions. */
export function StudioLoadErrorView({ code, message, onRetry, onCopy, onBack }: LoadErrorViewProps): JSX.Element {
  const t = i18n.studio.loadFailed
  return (
    <div className="studio-blocked" role="alert">
      <strong>{t.title}</strong>
      <p>{t.text.replace('{code}', String(code ?? 'unknown'))}</p>
      {message ? <p className="studio-error-detail"><code>{message}</code></p> : null}
      <div className="notice-actions">
        <button type="button" className="btn-accent" onClick={onRetry}>
          {t.retry}
        </button>
        <button type="button" className="btn-ghost" onClick={onCopy}>
          {i18n.studio.notices.copyError}
        </button>
        <button type="button" className="btn-ghost" onClick={onBack}>
          {i18n.studio.back}
        </button>
      </div>
    </div>
  )
}
