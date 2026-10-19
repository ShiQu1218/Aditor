import React from 'react'
import { i18n } from '../i18n'
import { ChevronLeft, Menu } from '../components/icons'

interface StudioHeaderProps {
  /** Video filename. */
  title: string
  /** Example: 1920×1080 · H.264 · 13:42 · 19 events. */
  meta: string
  statusDone: boolean
  asideOpen: boolean
  onBack: () => void
  onToggleAside: () => void
}

  /** Studio header: back, filename and metadata, status, and sidebar toggle. */
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
