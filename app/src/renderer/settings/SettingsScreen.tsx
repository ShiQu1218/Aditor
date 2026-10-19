import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useKeymap } from '../hooks/useShortcuts'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { useOptionalOverlay } from '../shell/OverlayHost'
import { settingsI18n, recordingI18n } from '../i18n'
import { SettingRow } from './SettingRow'
import { SettingsNav } from './SettingsNav'
import { SettingsSearch } from './SettingsSearch'
import { filterRows } from './filterRows'
import { CATEGORIES, SETTING_ROWS, recordingRowVisible, type CategoryId, type SettingRow as Row } from './rows'
import { SettingsController, type SettingsApi } from './settingsController'

const t = settingsI18n

interface SettingsScreenProps {
  /** 測試／DEV 注入；預設以 window.api 建立 */
  controller?: SettingsController
  initialQuery?: string
  initialCategory?: CategoryId
}

function defaultController(): SettingsController {
  const api = (typeof window !== 'undefined' ? window.api : undefined) as SettingsApi | undefined
  const missing: SettingsApi = {
    settings: {
      get: () => Promise.reject(new Error('settings api unavailable')),
      set: () => Promise.reject(new Error('settings api unavailable')),
      onChanged: () => () => undefined
    }
  }
  return new SettingsController(api?.settings ? api : missing)
}

/** 把連續同卡片（同分類）的列併成一張卡片。 */
function groupCards(rows: Row[]): Array<{ key: string; category: CategoryId; title: string; rows: Row[] }> {
  const cards: Array<{ key: string; category: CategoryId; title: string; rows: Row[] }> = []
  for (const r of rows) {
    const last = cards[cards.length - 1]
    if (last && last.title === r.card && last.category === r.category) last.rows.push(r)
    else cards.push({ key: `${r.category}:${r.card}`, category: r.category, title: r.card, rows: [r] })
  }
  return cards
}

export function SettingsScreen({ controller, initialQuery = '', initialCategory = 'a' }: SettingsScreenProps): JSX.Element {
  const ctrl = useMemo(() => controller ?? defaultController(), [controller])
  const state = useSyncExternalStore(ctrl.subscribe, ctrl.getState, ctrl.getState)
  const [query, setQuery] = useState(initialQuery)
  const [active, setActive] = useState<CategoryId>(initialCategory)
  const searchRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const narrow = useMediaQuery('(max-width: 899px)')
  const overlay = useOptionalOverlay()

  useEffect(() => {
    void ctrl.start()
    return () => ctrl.stop()
  }, [ctrl])

  // Ctrl+F 聚焦搜尋；Esc 清除搜尋字串（兩者都走 keymap：已排除 IME 組字與原生下拉）
  useKeymap(
    {
      focusSearch: () => {
        searchRef.current?.focus()
        searchRef.current?.select()
      },
      closeOverlay: () => setQuery(''),
      showShortcuts: overlay?.openShortcuts
    },
    { screen: 'settings' }
  )

  const searching = query.trim().length > 0
  const backend = state.settings?.recording.backend ?? 'builtin'
  const result = useMemo(() => filterRows(SETTING_ROWS.filter((row) => recordingRowVisible(row, backend)), query), [query, backend])
  const visible = searching ? CATEGORIES.flatMap((c) => result.byCategory[c.id]) : result.byCategory[active]
  const cards = useMemo(() => groupCards(visible), [visible])

  const select = useCallback(
    (id: CategoryId) => {
      setActive(id)
      if (searching) {
        // 搜尋中：所有命中分類同時顯示，切換分類＝捲到該分類的第一張卡片
        panelRef.current?.querySelector(`[data-cat="${id}"]`)?.scrollIntoView?.({ block: 'start' })
      } else if (panelRef.current) {
        panelRef.current.scrollTop = 0
      }
    },
    [searching]
  )

  const settings = state.settings

  return (
    <div className="set-screen">
      <header className="set-topbar">
        <h1>{t.title}</h1>
      </header>
      <div className="set-body">
        <SettingsNav
          active={active}
          onSelect={select}
          counts={searching ? result.counts : undefined}
          orientation={narrow ? 'horizontal' : 'vertical'}
        />
        <div className="set-pane">
          <SettingsSearch query={query} onChange={setQuery} inputRef={searchRef} />
          <div className="set-notice-host" role="status" aria-live="polite">
            {state.saveFailed && <p className="set-notice">{t.saveFailed}</p>}
            {state.loadFailed && <p className="set-notice">{t.loadFailed}</p>}
          </div>
          <div
            id="set-panel"
            ref={panelRef}
            className="set-wrap"
            {...(searching
              ? { role: 'region', 'aria-label': t.resultsLabel }
              : { role: 'tabpanel', 'aria-labelledby': `set-tab-${active}` })}
          >
            {!settings ? (
              <p className="set-empty-state">{t.loading}</p>
            ) : cards.length === 0 ? (
              <div className="set-empty-state" role="status">
                <strong>{t.noResults}</strong>
                <span>{t.noResultsHint}</span>
              </div>
            ) : (
              cards.map((card, i) => (
                <section
                  key={card.key}
                  className="set-card"
                  data-cat={card.category}
                  aria-labelledby={`set-card-${i}`}
                >
                  <h2 id={`set-card-${i}`}>{card.title}</h2>
                  {card.rows.filter((row) => !row.advanced).map((row) => (
                    <SettingRow key={row.id} row={row} state={state} settings={settings} controller={ctrl} />
                  ))}
                  {card.rows.some((row) => row.advanced) && (
                    <details className="set-advanced" open={searching || undefined}>
                      <summary>{recordingI18n.advanced}</summary>
                      {card.rows.filter((row) => row.advanced).map((row) => (
                        <SettingRow key={row.id} row={row} state={state} settings={settings} controller={ctrl} />
                      ))}
                    </details>
                  )}
                </section>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
