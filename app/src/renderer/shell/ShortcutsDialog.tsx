import React, { useRef } from 'react'
import { KEY_TABLE, type KeyRow } from '../input/keymap'
import { useFocusTrap } from '../a11y/useFocusTrap'
import { X } from '../components/icons'
import { shellI18n } from '../i18n/zh-TW'

/** 說明中分組的顯示順序（其餘 scope 依 KEY_TABLE 出現順序接在後面）。 */
const SCOPE_ORDER = [
  shellI18n.keymap.scope.global,
  shellI18n.keymap.scope.studio,
  shellI18n.keymap.scope.source,
  shellI18n.keymap.scope.hl,
  shellI18n.keymap.scope.ev,
  shellI18n.keymap.scope.proj,
  shellI18n.keymap.scope.library,
  `${shellI18n.keymap.scope.library}／${shellI18n.keymap.scope.settings}`
]

export interface KeyGroup {
  scope: string
  rows: KeyRow[]
}

/** 依 scope 分組（組內保持 KEY_TABLE 順序；每個 Command 恰出現一次）。 */
export function groupKeyRows(rows: readonly KeyRow[]): KeyGroup[] {
  const map = new Map<string, KeyRow[]>()
  for (const r of rows) map.set(r.scope, [...(map.get(r.scope) ?? []), r])
  const known = SCOPE_ORDER.filter((s) => map.has(s))
  const rest = [...map.keys()].filter((s) => !SCOPE_ORDER.includes(s))
  return [...known, ...rest].map((scope) => ({ scope, rows: map.get(scope)! }))
}

/**
 * 快捷鍵說明對話框：內容完全由 `KEY_TABLE` 產生（與 keymap 測試鎖定的是同一份表），
 * 不手寫第二份。Esc 由 OverlayProvider 在 window 層關閉（焦點在不在框內都有效）。
 */
export function ShortcutsDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const t = shellI18n.shortcutsDialog
  const boxRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  useFocusTrap(boxRef, { initialFocus: () => closeRef.current })
  const groups = groupKeyRows(KEY_TABLE)
  return (
    <div ref={boxRef} className="sc-dialog" role="dialog" aria-modal="true" aria-labelledby="sc-title">
      <header className="sc-head">
        <h2 id="sc-title">{t.title}</h2>
        <button ref={closeRef} type="button" className="icon-btn" aria-label={t.close} onClick={onClose}>
          <X className="ic" />
        </button>
      </header>
      <div className="sc-body" tabIndex={0} role="region" aria-labelledby="sc-title">
        {groups.map((g, gi) => (
          <section key={g.scope} className="sc-group" aria-labelledby={`sc-scope-${gi}`}>
            <h3 id={`sc-scope-${gi}`}>{g.scope}</h3>
            <dl className="sc-list">
              {g.rows.map((r) => (
                <div key={r.command} className="sc-row" data-command={r.command}>
                  <dt>{r.label}</dt>
                  <dd>
                    {r.keys.split(' ／ ').map((k) => (
                      <kbd key={k}>{k}</kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <p className="sc-hint dim">{t.hint}</p>
    </div>
  )
}
