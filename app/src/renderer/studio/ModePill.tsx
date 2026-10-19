import React from 'react'
import { i18n } from '../i18n'

interface ModePillProps {
  mode: 'source' | 'project'
  label: string
  /** The current playhead is within a spectator segment (yellow "watching" pill). */
  spectating?: boolean
}

  /** Mode pill at the top-left of the player: source uses white text on a dark background; project uses black text on white (spec §3.5). */
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
