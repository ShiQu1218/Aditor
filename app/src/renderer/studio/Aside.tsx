import React from 'react'
import { i18n } from '../i18n'
import { Sparkles } from '../components/icons'

interface AsideProps {
  hlCount: number
  locked: boolean
  children: React.ReactNode
}

/** 工作室側欄：精華清單。 */
export function Aside({ hlCount, locked, children }: AsideProps): JSX.Element {
  const t = i18n.studio.tabs
  return (
    <aside
      className="studio-aside"
      aria-label={t.asideLabel}
      data-editor-lock
      {...(locked ? ({ inert: '', 'aria-disabled': 'true' } as Record<string, string>) : {})}
    >
      <div className="aside-tabs">
        <h2 id="aside-tab-hl" className="aside-tab on">
          <Sparkles className="ic sm" /> {t.hl} {hlCount}
        </h2>
      </div>
      {children}
    </aside>
  )
}
