import React from 'react'
import { Search } from '../components/icons'
import { settingsI18n } from '../i18n'

interface SettingsSearchProps {
  query: string
  onChange: (q: string) => void
  inputRef: React.RefObject<HTMLInputElement>
}

/** Search box at the top of the content column. Ctrl+F focus and Esc clearing use keymap for IME-safe handling. */
export function SettingsSearch({ query, onChange, inputRef }: SettingsSearchProps): JSX.Element {
  return (
    <div className="set-search">
      <Search className="ic" />
      <input
        ref={inputRef}
        id="set-search"
        type="search"
        autoComplete="off"
        placeholder={settingsI18n.searchPlaceholder}
        aria-label={settingsI18n.searchLabel}
        value={query}
        onChange={(e) => onChange(e.target.value)}
      />
      <kbd>Ctrl F</kbd>
    </div>
  )
}
