import React from 'react'
import { Film, FolderInput, Plus } from '../components/icons'
import { i18n } from '../i18n/zh-TW'

const t = i18n.library.empty

export interface EmptyStateProps {
  onImportFiles: () => void
  onImportFolder: () => void
  onOpenSettings: () => void
}

/** 影片庫空狀態：投放區、三步驟說明與主要動作 */
export function EmptyState({ onImportFiles, onImportFolder, onOpenSettings }: EmptyStateProps): JSX.Element {
  return (
    <div className="lib-empty">
      <div className="box">
        <Film className="ic empty-icon" />
        <h2>{t.title}</h2>
        <p className="muted">{t.desc}</p>
        <div className="steps">
          <div className="step">
            <i>1</i>
            <b>{t.step1Title}</b>
            {t.step1Desc}
          </div>
          <div className="step">
            <i>2</i>
            <b>{t.step2Title}</b>
            {t.step2Desc}
          </div>
          <div className="step">
            <i>3</i>
            <b>{t.step3Title}</b>
            {t.step3Desc}
          </div>
        </div>
        <button type="button" className="lib-btn primary" onClick={onImportFiles}>
          <Plus className="ic" />
          {i18n.library.importFiles}
        </button>
        <button type="button" className="lib-btn" onClick={onImportFolder}>
          <FolderInput className="ic" />
          {i18n.library.importFolder}
        </button>
        <button type="button" className="lib-btn ghost" onClick={onOpenSettings}>
          {t.openSettings}
        </button>
      </div>
    </div>
  )
}
