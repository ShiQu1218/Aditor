import React from 'react'
import { i18n } from '../i18n/zh-TW'
import { ChevronLeft, Menu } from '../components/icons'

interface StudioHeaderProps {
  /** 影片檔名 */
  title: string
  /** 1920×1080 · H.264 · 13:42 · 19 個事件 */
  meta: string
  statusDone: boolean
  asideOpen: boolean
  onBack: () => void
  onToggleAside: () => void
}

/** 工作室頂欄：返回、檔名與資訊、狀態、側欄切換。 */
export function StudioHeader({
  title,
  meta,
  statusDone,
  asideOpen,
  onBack,
  onToggleAside
}: StudioHeaderProps): JSX.Element {
  const t = i18n.studio
  return (
    <header className="studio-head">
      <button type="button" className="icon-btn" aria-label={t.back} onClick={onBack}>
        <ChevronLeft className="ic" />
      </button>
      <div className="studio-title">
        <div className="studio-file">{title}</div>
        <div className="studio-meta dim mono">
          {meta}
          {statusDone && <span className="badge-status">{t.statusDone}</span>}
        </div>
      </div>
      <div className="studio-head-actions">
        <button
          type="button"
          className="icon-btn"
          aria-label={t.asideToggle}
          aria-pressed={asideOpen}
          onClick={onToggleAside}
        >
          <Menu className="ic" />
        </button>
      </div>
    </header>
  )
}
