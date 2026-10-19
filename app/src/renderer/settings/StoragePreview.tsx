import React from 'react'
import { settingsI18n } from '../i18n'
import {
  EXPORTS_DIRNAME,
  EXPORT_CLIPS_DIRNAME,
  EXPORT_MERGED_DIRNAME,
  RECORDINGS_DIRNAME,
  joinForDisplay
} from '../../shared/storage'

/**
 * 儲存位置的資料夾結構預覽（設定頁與首次啟動引導共用）：
 * 列出根資料夾底下三個子資料夾的實際路徑與用途。
 */
export function StoragePreview({ root }: { root: string }): JSX.Element {
  const t = settingsI18n.row.storageRoot.preview
  const lines: Array<{ key: string; path: string; label: string }> = [
    { key: 'recordings', path: joinForDisplay(root, RECORDINGS_DIRNAME, t.dayFolder), label: t.recordings },
    { key: 'merged', path: joinForDisplay(root, EXPORTS_DIRNAME, EXPORT_MERGED_DIRNAME), label: t.merged },
    { key: 'clips', path: joinForDisplay(root, EXPORTS_DIRNAME, EXPORT_CLIPS_DIRNAME), label: t.clips }
  ]
  return (
    <dl className="storage-preview" aria-label={t.heading}>
      {lines.map((line) => (
        <div key={line.key} className="storage-preview-row" data-folder={line.key}>
          <dt className="mono" title={line.path}>{line.path}</dt>
          <dd>{line.label}</dd>
        </div>
      ))}
    </dl>
  )
}
