import React, { useRef } from 'react'
import { Download, Film, Scissors } from '../components/icons'
import { settingsI18n } from '../i18n/zh-TW'
import { CATEGORIES, type CategoryId } from './rows'
import { fillTemplate, nextTabIndex } from './settingsModel'

const ICONS = { Film, Scissors, Download } as const

interface SettingsNavProps {
  active: CategoryId
  onSelect: (id: CategoryId) => void
  /** 搜尋中各分類的命中數；undefined＝沒有搜尋 */
  counts?: Partial<Record<CategoryId, number>>
  orientation: 'vertical' | 'horizontal'
}

/** 分類欄：role=tablist、roving tabindex、方向鍵／Home／End 切換並選取。 */
export function SettingsNav({ active, onSelect, counts, orientation }: SettingsNavProps): JSX.Element {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  const onKeyDown = (e: React.KeyboardEvent, index: number): void => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.nativeEvent.isComposing) return
    const next = nextTabIndex(e.key, index, CATEGORIES.length)
    if (next === null) return
    e.preventDefault()
    tabRefs.current[next]?.focus()
    onSelect(CATEGORIES[next].id)
  }

  return (
    <div className="set-nav" role="tablist" aria-label={settingsI18n.tablistLabel} aria-orientation={orientation}>
      {CATEGORIES.map((c, i) => {
        const Icon = ICONS[c.icon]
        const selected = c.id === active
        const hits = counts ? (counts[c.id] ?? 0) : null
        return (
          <button
            key={c.id}
            ref={(el) => {
              tabRefs.current[i] = el
            }}
            id={`set-tab-${c.id}`}
            type="button"
            role="tab"
            className={`set-cat${selected ? ' active' : ''}`}
            aria-selected={selected}
            aria-controls="set-panel"
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(c.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            <Icon className="ic" />
            <span className="set-cat-label">{c.label}</span>
            {hits !== null && hits > 0 && (
              <span className="set-hit" aria-label={fillTemplate(settingsI18n.hitCount, { n: hits })}>
                {hits}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
