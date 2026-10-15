import React from 'react'
import { ListVideo, Sparkles } from '../components/icons'
import { i18n } from '../i18n/zh-TW'

export type AsideTab = 'hl' | 'ev'

interface AsideProps {
  tab: AsideTab
  onTab: (tab: AsideTab) => void
  hlCount: number
  evCount: number
  /** 專案模式預覽他支影片時灰化停用（spec §3.5） */
  grayed: boolean
  children: React.ReactNode
}

/** 工作室側欄（spec §3.2.3）：精華／事件分頁列＋目前分頁內容。 */
export function Aside({ tab, onTab, hlCount, evCount, grayed, children }: AsideProps): JSX.Element {
  const t = i18n.studio.tabs
  return (
    <aside className={`studio-aside${grayed ? ' grayed' : ''}`} aria-label={t.asideLabel}>
      <div className="aside-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'hl'}
          className={`aside-tab${tab === 'hl' ? ' on' : ''}`}
          onClick={() => onTab('hl')}
        >
          <Sparkles className="ic sm" /> {t.hl} {hlCount}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'ev'}
          className={`aside-tab${tab === 'ev' ? ' on' : ''}`}
          onClick={() => onTab('ev')}
        >
          <ListVideo className="ic sm" /> {t.ev} {evCount}
        </button>
      </div>
      {children}
    </aside>
  )
}
