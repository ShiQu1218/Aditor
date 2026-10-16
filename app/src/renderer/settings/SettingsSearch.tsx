import React from 'react'
import { Search } from '../components/icons'
import { settingsI18n } from '../i18n/zh-TW'

interface SettingsSearchProps {
  query: string
  onChange: (q: string) => void
  inputRef: React.RefObject<HTMLInputElement>
}

/** 搜尋框（內容欄頂端）。Ctrl+F 聚焦與 Esc 清除都走 keymap，這裡不另外處理按鍵（IME 組字安全）。 */
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
