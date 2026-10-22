import React from 'react'
import { RefreshCw } from '../components/icons'
import { settingsI18n } from '../i18n'
import { describedBy, type ControlIds } from './SettingControls'
import { fillTemplate } from './settingsModel'
import type { SettingsController } from './settingsController'
import type { UpdateStatus } from '../../shared/update'

const t = settingsI18n.row.updateStatus

function statusText(s: UpdateStatus): string {
  switch (s.state) {
    case 'unsupported':
      return t.unsupported
    case 'idle':
      return t.idle
    case 'checking':
      return t.checking
    case 'latest':
      return t.latest
    case 'available':
      return fillTemplate(t.available, { version: s.version ?? '' })
    case 'downloading':
      return fillTemplate(t.downloading, { version: s.version ?? '', pct: s.percent ?? 0 })
    case 'downloaded':
      return fillTemplate(t.downloaded, { version: s.version ?? '' })
    case 'error':
      return fillTemplate(t.error, { msg: s.error ?? '' })
  }
}

/** Update status and actions: check, download, or restart and install; portable builds open the download page instead. */
export function UpdateControl({ ids, status, controller }: { ids: ControlIds; status: UpdateStatus; controller: SettingsController }): JSX.Element {
  const statusId = `${ids.ctl}-status`
  let action: JSX.Element
  if (status.state === 'unsupported') {
    action = (
      <button id={ids.ctl} type="button" className="set-btn sm" aria-describedby={describedBy(ids, statusId)} onClick={() => void controller.openReleases()}>
        {t.openReleases}
      </button>
    )
  } else if (status.state === 'available') {
    action = (
      <button id={ids.ctl} type="button" className="set-btn sm" aria-describedby={describedBy(ids, statusId)} onClick={() => void controller.downloadUpdate()}>
        {t.download}
      </button>
    )
  } else if (status.state === 'downloaded') {
    action = (
      <button id={ids.ctl} type="button" className="set-btn sm" aria-describedby={describedBy(ids, statusId)} onClick={() => void controller.installUpdate()}>
        {t.install}
      </button>
    )
  } else if (status.state === 'downloading') {
    action = (
      <button id={ids.ctl} type="button" className="set-btn sm" disabled aria-describedby={describedBy(ids, statusId)}>
        {t.download}
      </button>
    )
  } else {
    action = (
      <button id={ids.ctl} type="button" className="set-btn sm" disabled={status.state === 'checking'} aria-describedby={describedBy(ids, statusId)} onClick={() => void controller.checkUpdate()}>
        <RefreshCw className="ic sm" />
        {t.check}
      </button>
    )
  }
  return (
    <div className="set-inline">
      <span id={statusId} className={`set-value${status.state === 'error' ? ' wrap' : ''}`} role="status" aria-live="polite">
        {statusText(status)}
      </span>
      {action}
    </div>
  )
}
