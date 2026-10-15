import React from 'react'
import { i18n } from '../i18n/zh-TW'

interface ModePillProps {
  mode: 'source' | 'project'
  label: string
  /** 目前播放位置落在觀戰區間（黃色「觀戰中」膠囊） */
  spectating?: boolean
}

/** 播放器左上的模式膠囊：來源＝深底白字；專案＝白底黑字（spec §3.5）。 */
export function ModePill({ mode, label, spectating }: ModePillProps): JSX.Element {
  return (
    <div className="mode-pills">
      <span className={`mode-pill${mode === 'project' ? ' is-project' : ' is-source'}`}>
        <i className="mode-dot" aria-hidden="true" />
        {label}
      </span>
      {spectating && <span className="mode-pill is-spectating">{i18n.studio.mode.spectating}</span>}
    </div>
  )
}
