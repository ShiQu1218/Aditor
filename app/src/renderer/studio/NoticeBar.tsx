import React from 'react'
import { AlertTriangle } from '../components/icons'
import { i18n } from '../i18n'
import type { NoticeAction, StudioNotice } from './notices'

interface NoticeBarProps {
  notice: StudioNotice
  onAction: (a: NoticeAction) => void
  /** 代理檔產生中：顯示進行中文字並停用動作 */
  busy?: boolean
}

const ACTION_LABEL: Record<NoticeAction, string> = {
  resume: i18n.studio.notices.resume,
  copyError: i18n.studio.notices.copyError,
  generateProxy: i18n.studio.notices.proxyGenerate,
  later: i18n.studio.notices.proxyLater,
  relink: i18n.studio.notices.relink,
  back: i18n.studio.notices.back
}

/** 工作室頂部狀態列：引擎異常／代理檔建議／產生中。 */
export function NoticeBar({ notice, onAction, busy }: NoticeBarProps): JSX.Element {
  return (
    <div className={`notice notice-${notice.kind}`} role="status">
      <AlertTriangle className="ic" aria-hidden="true" />
      <div className="notice-text">
        <strong>{notice.title}</strong>
        {notice.text && <span className="notice-desc">{notice.text}</span>}
      </div>
      <div className="notice-actions">
        {busy ? (
          <span className="dim">{i18n.studio.notices.proxyBusy}</span>
        ) : (
          notice.actions.map((a) => (
            <button
              key={a}
              type="button"
              className={a === 'generateProxy' || a === 'resume' ? 'btn-accent' : 'btn-ghost'}
              onClick={() => onAction(a)}
            >
              {ACTION_LABEL[a]}
            </button>
          ))
        )}
      </div>
    </div>
  )
}
