import React from 'react'
import { i18n } from '../i18n/zh-TW'

export interface TriStateProps {
  /** `counted_override`：null＝自動、true＝強制計入、false＝強制不計入 */
  value: boolean | null
  onChange: (value: boolean | null) => void
  /** aria 群組名稱（列內為「計入統計」） */
  label?: string
  /** roving tabindex：清單中非作用列傳 -1（預設 0） */
  tabIndex?: number
}

const OPTIONS: Array<{ value: boolean | null; cls: string }> = [
  { value: null, cls: 'auto' },
  { value: true, cls: 'yes' },
  { value: false, cls: 'no' }
]

/**
 * 計入三態分段按鈕〔自動｜計入｜不計〕（spec §3.2.3）：
 * 一眼可見目前 `counted_override`，取代舊版循環按鈕。
 */
export function TriState({ value, onChange, label, tabIndex = 0 }: TriStateProps): JSX.Element {
  const t = i18n.studio.ev
  const text: Record<string, string> = { auto: t.auto, yes: t.yes, no: t.no }
  return (
    <span className="tri" role="group" aria-label={label ?? t.triLabel}>
      {OPTIONS.map((o) => {
        const on = value === o.value
        return (
          <button
            key={o.cls}
            type="button"
            tabIndex={tabIndex}
            className={`tri-btn${on ? ' on' : ''}${on && o.cls !== 'auto' ? ` ${o.cls}` : ''}`}
            aria-pressed={on}
            onClick={(e) => {
              e.stopPropagation()
              onChange(o.value)
            }}
          >
            {text[o.cls]}
          </button>
        )
      })}
    </span>
  )
}
