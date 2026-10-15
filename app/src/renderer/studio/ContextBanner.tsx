import React from 'react'
import { i18n } from '../i18n/zh-TW'

interface ContextBannerProps {
  /** 1-based 片段序號 */
  index: number
  label: string
  sourceName: string
  onBackToSource: () => void
}

/** 專案模式的脈絡橫幅：說明目前預覽的片段來源，提供〔返回來源 Esc〕。 */
export function ContextBanner({ index, label, sourceName, onBackToSource }: ContextBannerProps): JSX.Element {
  const c = i18n.studio.context
  const text = c.text
    .replace('{i}', String(index))
    .replace('{label}', label)
    .replace('{name}', sourceName)
  return (
    <div className="ctx-banner" role="status">
      <span className="ctx-text">{text}</span>
      <button type="button" className="btn-ghost" onClick={onBackToSource}>
        {c.backToSource}
      </button>
    </div>
  )
}
