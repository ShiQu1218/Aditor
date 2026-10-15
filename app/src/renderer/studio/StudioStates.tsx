import React from 'react'
import { i18n } from '../i18n/zh-TW'

/** 工作室載入前／被擋下／載入失敗的整頁狀態（不顯示任何假資料）。 */
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
  onRetry: () => void
  onCopy: () => void
  onBack: () => void
}

/** 載入失敗：錯誤代碼＋〔重試〕〔複製錯誤訊息〕〔返回影片庫〕。 */
export function StudioLoadErrorView({ code, onRetry, onCopy, onBack }: LoadErrorViewProps): JSX.Element {
  const t = i18n.studio.loadFailed
  return (
    <div className="studio-blocked" role="alert">
      <strong>{t.title}</strong>
      <p>{t.text.replace('{code}', String(code ?? 'unknown'))}</p>
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
