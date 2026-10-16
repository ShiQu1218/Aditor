import React, { useRef } from 'react'
import { rovingStep } from '../a11y/roving'
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
  /** 匯出進行中：整個側欄 inert（不可點、不可聚焦）；也標 data-editor-lock 讓 useEditorLock 統一解除 */
  locked?: boolean
  children: React.ReactNode
}

/** 工作室側欄（spec §3.2.3）：精華／事件分頁列＋目前分頁內容。 */
export function Aside({ tab, onTab, hlCount, evCount, grayed, locked = false, children }: AsideProps): JSX.Element {
  const t = i18n.studio.tabs
  const tabRefs = useRef<Record<AsideTab, HTMLButtonElement | null>>({ hl: null, ev: null })
  const order: AsideTab[] = ['hl', 'ev']

  // tablist 鍵盤：←→（與 Home／End）切換分頁並移動焦點；只有選取中的分頁在 Tab 順序內（roving tabindex）
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.nativeEvent.isComposing) return
    const at = order.indexOf(tab)
    let next = rovingStep({ count: order.length, index: at, key: e.key, columns: order.length, orientation: 'horizontal' })
    if (next === null && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) next = (at + (e.key === 'ArrowRight' ? 1 : -1) + order.length) % order.length // 環繞
    if (next === null) return
    e.preventDefault()
    onTab(order[next])
    tabRefs.current[order[next]]?.focus()
  }

  return (
    <aside
      className={`studio-aside${grayed ? ' grayed' : ''}`}
      aria-label={t.asideLabel}
      data-editor-lock
      // 側欄在鎖定期間才掛載（Ctrl+B 收起再展開）時也要 inert，不能只靠鎖定當下的一次性掃描
      {...(locked ? ({ inert: '', 'aria-disabled': 'true' } as Record<string, string>) : {})}
    >
      <div className="aside-tabs" role="tablist" onKeyDown={onKeyDown}>
        <button
          type="button"
          role="tab"
          id="aside-tab-hl"
          ref={(el) => {
            tabRefs.current.hl = el
          }}
          aria-selected={tab === 'hl'}
          aria-controls="aside-panel"
          tabIndex={tab === 'hl' ? 0 : -1}
          className={`aside-tab${tab === 'hl' ? ' on' : ''}`}
          onClick={() => onTab('hl')}
        >
          <Sparkles className="ic sm" /> {t.hl} {hlCount}
        </button>
        <button
          type="button"
          role="tab"
          id="aside-tab-ev"
          ref={(el) => {
            tabRefs.current.ev = el
          }}
          aria-selected={tab === 'ev'}
          aria-controls="aside-panel"
          tabIndex={tab === 'ev' ? 0 : -1}
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
