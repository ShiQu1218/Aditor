import React from 'react'
import { LayoutGrid, Film, Keyboard, SlidersHorizontal, LogoMark } from '../components/icons'
import { QueueRing } from './QueueRing'
import { shellI18n } from '../i18n/zh-TW'

export type RailView = 'library' | 'studio' | 'settings'

interface RailProps {
  /** 目前頁面 */
  active: RailView | null
  projectCount: number
  onNavigate: (v: RailView) => void
  onShortcuts?: () => void
  onQueue?: () => void
  /** 佇列浮層是否開啟（aria-expanded） */
  queueOpen?: boolean
  /** 供佇列浮層判斷「點擊外部」時排除觸發按鈕 */
  queueButtonRef?: React.Ref<HTMLButtonElement>
}

export function Rail({ active, projectCount, onNavigate, onShortcuts, onQueue, queueOpen = false, queueButtonRef }: RailProps): JSX.Element {
  const t = shellI18n.rail
  const btn = (view: RailView, tip: string, label: string, icon: JSX.Element, badge?: number) => (
    <button
      className={`rail-btn${active === view ? ' active' : ''}`}
      data-tip={tip}
      aria-label={label}
      aria-current={active === view ? 'page' : undefined}
      onClick={() => onNavigate(view)}
    >
      {icon}
      {badge ? <span className="badge">{badge}</span> : null}
    </button>
  )
  return (
    <nav className="rail" aria-label={t.mainNav}>
      <LogoMark className="logo" />
      {btn('library', t.library, t.library, <LayoutGrid className="ic lg" />)}
      {btn('studio', t.studio, t.studioLabel, <Film className="ic lg" />, projectCount)}
      <div className="rail-spacer" />
      <button
        className="rail-btn"
        data-tip={t.queue}
        aria-label={t.queue}
        aria-haspopup="dialog"
        aria-expanded={queueOpen}
        ref={queueButtonRef}
        onClick={onQueue}
      >
        <QueueRing />
      </button>
      <button
        type="button"
        className="rail-btn"
        data-tip={t.shortcuts}
        aria-label={t.shortcutsLabel}
        aria-haspopup="dialog"
        onClick={onShortcuts}
      >
        <Keyboard className="ic lg" />
      </button>
      {btn('settings', t.settings, t.settings, <SlidersHorizontal className="ic lg" />)}
    </nav>
  )
}
