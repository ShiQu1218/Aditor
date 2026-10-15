import React from 'react'
import { i18n } from '../i18n/zh-TW'
import { ChevronLeft, Download, Menu, Scissors, Sparkles } from '../components/icons'

interface StudioHeaderProps {
  /** 影片檔名 */
  title: string
  /** 1920×1080 · H.264 · 13:42 · 19 個事件 */
  meta: string
  statusDone: boolean
  mode: 'source' | 'project'
  exportCount: number
  asideOpen: boolean
  onBack: () => void
  onAutoClip: () => void
  onQuick: () => void
  onExport: () => void
  onToggleAside: () => void
}

/** 工作室頂欄：返回、檔名與資訊、狀態、AI 自動剪輯、快速剪輯／分割、匯出、側欄切換。 */
export function StudioHeader({
  title,
  meta,
  statusDone,
  mode,
  exportCount,
  asideOpen,
  onBack,
  onAutoClip,
  onQuick,
  onExport,
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
        <button type="button" className="btn-ghost" onClick={onAutoClip}>
          <Sparkles className="ic sm" /> {t.autoClip}
        </button>
        <button type="button" className="btn-ghost" onClick={onQuick}>
          <Scissors className="ic sm" /> {mode === 'project' ? t.splitClip : t.quickClip} <kbd>{t.quickClipKey}</kbd>
        </button>
        <button type="button" className="btn-accent" onClick={onExport}>
          <Download className="ic sm" /> {t.exportCount.replace('{n}', String(exportCount))}
        </button>
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
