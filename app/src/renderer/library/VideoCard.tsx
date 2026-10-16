import React, { useEffect, useId, useRef, useState } from 'react'
import type { LibraryEntry } from '../../main/library'
import type { VideoInfo } from '../../shared/types'
import { formatTime } from '../../shared/time'
import { formatEta } from '../../shared/eta'
import { containerCodecSupported } from '../media/playability'
import { useQueueEta, useQueueItemState } from '../queue/QueueProvider'
import { i18n } from '../i18n/zh-TW'
import { nextTrapIndex } from '../a11y/focusTrap'
import { rovingStep } from '../a11y/roving'
import { AlertTriangle, ImageOff, MoreHorizontal, RefreshCw, Star, Trash2 } from '../components/icons'

const t = i18n.library.card

export interface VideoCardProps {
  entry: LibraryEntry
  /** 任何點擊／Enter 都回報；由呼叫端決定開啟或顯示 Toast */
  onOpen: (entry: LibraryEntry) => void
  onToggleFavorite: (path: string) => void
  onRemove: (path: string) => void
  onRetry: (path: string) => void
  /** 卡片選單開／關時通報（開啟時帶關閉函式）：Esc 由 keymap 依「選單 → 搜尋」分層處理 */
  onMenuChange?: (path: string, close: (() => void) | null) => void
  /** 設定「建議代理檔」：false 時不顯示「建議代理檔」徽章（預設 true） */
  proxySuggest?: boolean
  /**
   * roving tabindex：網格中只有游標卡片的控制項在 Tab 順序內（其餘 tabIndex=-1，仍可用滑鼠／方向鍵到達）。
   * 單獨使用（沒有網格）時預設 true。
   */
  active?: boolean
}

/**
 * 左上角「建議代理檔」徽章：AV1 一律提示（硬體解碼支援罕見）；
 * 容器或編碼非 Chromium 可播放者亦提示（正式的可播放／硬體解碼判定在工作室 notice）。
 */
export function proxyBadge(entry: LibraryEntry): string | null {
  const codec = (entry.codec ?? '').toLowerCase()
  if (!codec) return null
  if (codec === 'av1' || codec === 'av01') return t.av1
  const container = entry.path.split('.').pop() ?? ''
  if (!containerCodecSupported({ codec } as VideoInfo, container)) return t.proxySuggest
  return null
}

export function fileName(path: string): string {
  return path.split(/[/\\]/).pop() || path
}

/** 卡片只在這些欄位變動時需要重繪（進度已另有 2 Hz 節流） */
export function sameCardEntry(a: LibraryEntry, b: LibraryEntry): boolean {
  return (
    a.path === b.path &&
    a.status === b.status &&
    a.progress === b.progress &&
    a.analyzingSince === b.analyzingSince &&
    a.favorite === b.favorite &&
    a.error === b.error &&
    a.hl === b.hl &&
    a.durationSec === b.durationSec &&
    a.thumb === b.thumb &&
    a.codec === b.codec &&
    a.counts?.knock === b.counts?.knock &&
    a.counts?.assist === b.counts?.assist
  )
}

function VideoCardView({ entry, onOpen, onToggleFavorite, onRemove, onRetry, onMenuChange, proxySuggest = true, active = true }: VideoCardProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const rootRef = useRef<HTMLElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  /** 選單開啟期間焦點是否在選單內：關閉時才知道要不要把焦點還給 ⋯ 按鈕 */
  const menuHadFocus = useRef(false)
  const moreId = useId()
  const tab = active ? 0 : -1
  const name = fileName(entry.path)
  const title = name.replace(/\.[^.]+$/, '')
  const badge = proxySuggest ? proxyBadge(entry) : null
  const done = entry.status === 'done'
  const error = entry.status === 'error'
  // 「等待中」只看 main 的真實佇列：status 為 pending 但不在佇列的（匯入未排隊、取消後）是「尚未分析」
  const queueState = useQueueItemState(entry.path)
  const notQueued = entry.status === 'pending' && queueState === 'idle'
  const statusText = done
    ? ''
    : error
      ? t.error
      : entry.status === 'analyzing'
        ? t.analyzing
        : notQueued
          ? t.notAnalyzed
          : t.waiting
  const eta = useQueueEta(entry.path)

  useEffect(() => {
    if (!menuOpen) return
    onMenuChange?.(entry.path, () => setMenuOpen(false))
    const close = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => {
      window.removeEventListener('mousedown', close)
      onMenuChange?.(entry.path, null)
    }
  }, [menuOpen, entry.path, onMenuChange])

  // 選單開啟：焦點移到第一個選項；關閉：焦點若在選單內，回到 ⋯ 觸發按鈕
  useEffect(() => {
    if (!menuOpen) return
    const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')
    first?.focus()
    menuHadFocus.current = first !== undefined && first !== null
    return () => {
      if (menuHadFocus.current) moreRef.current?.focus()
      menuHadFocus.current = false
    }
  }, [menuOpen])

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
    const at = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      items[nextTrapIndex(items.length, at, e.key === 'ArrowUp')]?.focus()
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      const i = rovingStep({ count: items.length, index: at, key: e.key, columns: 1, orientation: 'vertical' })
      if (i !== null) items[i]?.focus()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation() // 只關選單，不讓影片庫的 Esc（清除搜尋）一起處理
      setMenuOpen(false)
    } else if (e.key === 'Tab') {
      // 選單不攔截 Tab：關閉並讓焦點從 ⋯ 按鈕接著往下走
      menuHadFocus.current = false
      moreRef.current?.focus()
      setMenuOpen(false)
    }
  }

  // 惰性「N 精華」（spec §7.4）：卡片首次進入視窗、分析完成且尚無記錄時，請主程序以預設參數計算
  const wantHl = done && entry.hl === undefined
  useEffect(() => {
    if (!wantHl) return
    const el = rootRef.current
    if (!el) return
    let requested = false
    const request = (): void => {
      if (requested) return
      requested = true
      void window.api?.library?.computeHl?.(entry.path)
    }
    if (typeof IntersectionObserver === 'undefined') {
      request()
      return
    }
    const io = new IntersectionObserver((observed) => {
      if (observed.some((o) => o.isIntersecting)) {
        request()
        io.disconnect()
      }
    })
    io.observe(el)
    return () => io.disconnect()
  }, [wantHl, entry.path])

  const label = statusText ? `${title} · ${statusText}` : title

  // 結構：<article>（無 role、無鍵盤處理）裡只有一個主要按鈕 .vcard-open（縮圖＋文字，負責開啟），
  // 其餘互動元件（收藏、⋯、分析、重試、移除）都是它的「兄弟」，不巢狀；Enter／Space 由原生 <button> 處理。
  return (
    <article ref={rootRef} className={`vcard${error ? ' err' : ''}${done ? '' : ' busy'}`} data-vcard-path={entry.path}>
      <button
        type="button"
        className="vcard-open"
        aria-label={label}
        aria-disabled={!done}
        tabIndex={tab}
        onClick={() => onOpen(entry)}
      >
        <span className="vcard-thumb">
          {entry.thumb ? (
            <img src={`file://${entry.thumb.replace(/\\/g, '/')}`} alt="" loading="lazy" decoding="async" />
          ) : (
            <span className="vcard-nothumb">
              <ImageOff className="ic lg" />
              <span>{t.noThumb}</span>
            </span>
          )}

          {badge && <span className="lib-pill warn vcard-badge">{badge}</span>}

          {done && (
            <span className="vcard-counts">
              {(entry.counts?.knock ?? 0) > 0 && (
                <span className="vbadge knock">{t.knockBadge.replace('{n}', String(entry.counts?.knock ?? 0))}</span>
              )}
              {(entry.counts?.assist ?? 0) > 0 && (
                <span className="vbadge assist">{t.assistBadge.replace('{n}', String(entry.counts?.assist ?? 0))}</span>
              )}
              {(entry.hl ?? 0) > 0 && <span className="vbadge hl">{t.hlCount.replace('{n}', String(entry.hl))}</span>}
            </span>
          )}

          {entry.durationSec ? <span className="vcard-dur mono">{formatTime(entry.durationSec)}</span> : null}

          {entry.status === 'pending' && !notQueued && (
            <span className="vcard-overlay" role="status">
              <span>
                {t.waiting}
                <small>{t.waitingQueue}</small>
              </span>
            </span>
          )}
          {notQueued && (
            <span className="vcard-overlay" role="status">
              <span>
                {t.notAnalyzed}
                <small>{t.notAnalyzedHint}</small>
              </span>
            </span>
          )}
          {entry.status === 'analyzing' && (
            <>
              <span className="vcard-overlay" role="status">
                <span>
                  {t.progressText.replace('{n}', String(Math.round((entry.progress ?? 0) * 100)))}
                  {eta != null ? ` · ${formatEta(eta)}` : ''}
                  <small>{t.openBlocked}</small>
                </span>
              </span>
              <span className="vcard-progress">
                <i style={{ width: `${Math.round((entry.progress ?? 0) * 100)}%` }} />
              </span>
            </>
          )}
        </span>

        <span className="vcard-body">
          <span className="vcard-name" title={name}>
            {title}
          </span>
          {error ? (
            <span className="vcard-error-reason" title={entry.error}>
              <AlertTriangle className="ic sm" />
              <span>{entry.error || t.error}</span>
            </span>
          ) : (
            <span className="vcard-meta">
              <span>{new Date(entry.addedAt).toLocaleString('zh-TW', { hour12: false })}</span>
              {entry.codec ? <span className="vcard-codec">{entry.codec.toUpperCase()}</span> : null}
            </span>
          )}
        </span>
      </button>

      <button
        type="button"
        className={`vcard-fav${entry.favorite ? ' on' : ''}`}
        aria-label={entry.favorite ? t.favoriteRemove : t.favoriteAdd}
        aria-pressed={entry.favorite}
        tabIndex={tab}
        onClick={() => onToggleFavorite(entry.path)}
      >
        <Star className="ic" fill={entry.favorite ? 'currentColor' : 'none'} />
      </button>

      {notQueued && (
        <button type="button" className="lib-btn sm primary vcard-analyze" tabIndex={tab} onClick={() => onRetry(entry.path)}>
          {t.analyze}
        </button>
      )}

      {error && (
        <div className="vcard-error-actions">
          <button type="button" className="lib-btn sm" tabIndex={tab} onClick={() => onRetry(entry.path)}>
            {t.retry}
          </button>
          <button type="button" className="lib-btn sm" tabIndex={tab} onClick={() => onRemove(entry.path)}>
            {t.remove}
          </button>
        </div>
      )}

      <div className="vcard-menu-wrap">
        <button
          type="button"
          ref={moreRef}
          id={moreId}
          className="vcard-more"
          aria-label={t.more}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          tabIndex={tab}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <MoreHorizontal className="ic" />
        </button>
        {menuOpen && (
          <div className="vcard-menu" role="menu" aria-labelledby={moreId} ref={menuRef} onKeyDown={onMenuKeyDown}>
            {(done || error) && (
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  setMenuOpen(false)
                  onRetry(entry.path)
                }}
              >
                <RefreshCw className="ic sm" />
                {t.reanalyze}
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                setMenuOpen(false)
                onRemove(entry.path)
              }}
            >
              <Trash2 className="ic sm" />
              {t.remove}
            </button>
          </div>
        )}
      </div>
    </article>
  )
}

export const VideoCard = React.memo(VideoCardView, (a, b) => sameCardEntry(a.entry, b.entry) && (a.proxySuggest ?? true) === (b.proxySuggest ?? true) && (a.active ?? true) === (b.active ?? true))
