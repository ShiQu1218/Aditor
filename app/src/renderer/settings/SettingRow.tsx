import React from 'react'
import { settingsI18n } from '../i18n'
import { Globe } from '../components/icons'
import { SettingControl, type ControlIds } from './SettingControls'
import type { SettingsController, SettingsState } from './settingsController'
import type { SettingRow as Row } from './rows'
import type { Settings } from '../../shared/settings'

interface SettingRowProps {
  row: Row
  state: SettingsState
  settings: Settings
  controller: SettingsController
}

/** These controls are groups of inputs named by their heading via aria-labelledby; others use <label for>. */
const GROUP_KINDS = new Set(['numberPair', 'autoclip', 'none'])
/** Wide controls (lists and parameter tables) span the full row below the title. */
const WIDE_KINDS = new Set(['watchFolders', 'autoclip', 'storageRoot'])

export function SettingRow({ row, state, settings, controller }: SettingRowProps): JSX.Element {
  const error = state.rowErrors[row.id]
  const ids: ControlIds = {
    ctl: `set-${row.id}`,
    title: `set-${row.id}-title`,
    desc: row.desc ? `set-${row.id}-desc` : undefined,
    reason: row.disabledReason ? `set-${row.id}-reason` : undefined,
    err: error ? `set-${row.id}-err` : undefined
  }
  const kind = row.control.kind
  const grouped = GROUP_KINDS.has(kind) || row.control.kind === 'recording' && ['fps', 'aspectMode'].includes(row.control.field)
  return (
    <div
      className={`set-row${WIDE_KINDS.has(kind) ? ' wide' : ''}${row.disabledReason ? ' is-disabled' : ''}`}
      data-row={row.id}
      data-disabled={row.disabledReason ? 'true' : undefined}
    >
      <div className="set-text">
        {grouped ? (
          <span id={ids.title} className="set-title">
            {row.title}
          </span>
        ) : (
          <label id={ids.title} htmlFor={ids.ctl} className="set-title">
            {row.icon === 'Globe' && <Globe className="set-title-ico" size={16} aria-hidden="true" />}
            {row.title}
          </label>
        )}
        {row.isNew && <span className="set-newtag">{settingsI18n.newTag}</span>}
        {row.desc && (
          <small id={ids.desc} className="set-desc">
            {row.desc}
          </small>
        )}
        {row.disabledReason && (
          <small id={ids.reason} className="set-desc set-grey">
            {row.disabledReason}
          </small>
        )}
      </div>
      <div className="set-ctl">
        <SettingControl
          row={row}
          ids={ids}
          state={state}
          settings={settings}
          controller={controller}
          disabled={false}
        />
      </div>
      {error && (
        <p id={ids.err} className="set-err" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
