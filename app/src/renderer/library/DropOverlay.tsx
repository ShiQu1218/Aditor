import React from 'react'
import { i18n } from '../i18n/zh-TW'

/** 整頁拖放覆蓋層（拖曳檔案進入影片庫時顯示） */
export function DropOverlay({ show }: { show: boolean }): JSX.Element | null {
  if (!show) return null
  return (
    <div className="drop-overlay show" aria-hidden="true">
      <div>
        {i18n.library.drop.title}
        <br />
        <span className="drop-sub">{i18n.library.drop.desc}</span>
      </div>
    </div>
  )
}
