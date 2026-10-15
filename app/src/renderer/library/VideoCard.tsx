import React, { useEffect, useRef, useState } from 'react'
import type { LibraryEntry } from '../../main/library'
import type { VideoInfo } from '../../shared/types'
import { formatTime } from '../../shared/time'
import { containerCodecSupported } from '../media/playability'
import { i18n } from '../i18n/zh-TW'
import { AlertTriangle, ImageOff, MoreHorizontal, RefreshCw, Star, Trash2 } from '../components/icons'

const t = i18n.library.card

export interface VideoCardProps {
  entry: LibraryEntry
  /** 任何點擊／Enter 都回報；由呼叫端決定開啟或顯示 Toast */
  onOpen: (entry: LibraryEntry) => void
  onToggleFavorite: (path: string) => void
  onRemove: (path: string) => void
  onRetry: (path: string) => void
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

function VideoCardView({ entry, onOpen, onToggleFavorite, onRemove, onRetry }: VideoCardProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const rootRef = useRef<HTMLElement>(null)
  const name = fileName(entry.path)
  const title = name.replace(/\.[^.]+$/, '')
  const badge = proxyBadge(entry)
  const done = entry.status === 'done'
  const error = entry.status === 'error'
  const statusText = done ? '' : error ? t.error : entry.status === 'analyzing' ? t.analyzing : t.waiting

  useEffect(() => {
    if (!menuOpen) return
    const close = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menuOpen])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onOpen(entry)
    } else if (e.key === 'Delete') {
      e.preventDefault()
      onRemove(entry.path)
    } else if (e.key === 'Escape') {
      setMenuOpen(false)
    }
  }

  return (
    <article
      ref={rootRef}
      className={`vcard${error ? ' err' : ''}${done ? '' : ' busy'}`}
      role="button"
      tabIndex={0}
      aria-label={statusText ? `${title} · ${statusText}` : title}
      aria-disabled={!done}
      onClick={() => onOpen(entry)}
      onKeyDown={onKeyDown}
    >
      <div className="vcard-thumb">
        {entry.thumb ? (
          <img src={`file://${entry.thumb.replace(/\\/g, '/')}`} alt="" loading="lazy" decoding="async" />
        ) : (
          <div className="vcard-nothumb">
            <ImageOff className="ic lg" />
            <span>{t.noThumb}</span>
          </div>
        )}

        {badge && <span className="pill warn vcard-badge">{badge}</span>}

        <button
          type="button"
          className={`vcard-fav${entry.favorite ? ' on' : ''}`}
          aria-label={entry.favorite ? t.favoriteRemove : t.favoriteAdd}
          aria-pressed={entry.favorite}
          onClick={(e) => {
            e.stopPropagation()
            onToggleFavorite(entry.path)
          }}
        >
          <Star className="ic" fill={entry.favorite ? 'currentColor' : 'none'} />
        </button>

        {done && (
          <div className="vcard-counts">
            {(entry.counts?.knock ?? 0) > 0 && (
              <span className="vbadge knock">
                {t.knockBadge.replace('{n}', String(entry.counts?.knock ?? 0))}
              </span>
            )}
            {(entry.counts?.assist ?? 0) > 0 && (
              <span className="vbadge assist">
                {t.assistBadge.replace('{n}', String(entry.counts?.assist ?? 0))}
              </span>
            )}
            {(entry.hl ?? 0) > 0 && <span className="vbadge hl">{t.hlCount.replace('{n}', String(entry.hl))}</span>}
          </div>
        )}

        {entry.durationSec ? <span className="vcard-dur mono">{formatTime(entry.durationSec)}</span> : null}

        <div className="vcard-menu-wrap">
          <button
            type="button"
            className="vcard-more"
            aria-label={t.more}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(e) => {
              e.stopPropagation()
              setMenuOpen((v) => !v)
            }}
          >
            <MoreHorizontal className="ic" />
          </button>
          {menuOpen && (
            <div className="vcard-menu" role="menu">
              {(done || error) && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={(e) => {
                    e.stopPropagation()
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
                onClick={(e) => {
                  e.stopPropagation()
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

        {entry.status === 'pending' && (
          <div className="vcard-overlay" role="status">
            <div>
              {t.waiting}
              <small>{t.waitingQueue}</small>
            </div>
          </div>
        )}
        {entry.status === 'analyzing' && (
          <>
            <div className="vcard-overlay" role="status">
              <div>
                {t.progressText.replace('{n}', String(Math.round((entry.progress ?? 0) * 100)))}
                <small>{t.openBlocked}</small>
              </div>
            </div>
            <div className="vcard-progress">
              <i style={{ width: `${Math.round((entry.progress ?? 0) * 100)}%` }} />
            </div>
          </>
        )}
      </div>

      <div className="vcard-body">
        <div className="vcard-name" title={name}>
          {title}
        </div>
        {error ? (
          <div className="vcard-error">
            <div className="vcard-error-reason" title={entry.error}>
              <AlertTriangle className="ic sm" />
              <span>{entry.error || t.error}</span>
            </div>
            <div className="vcard-error-actions">
              <button
                type="button"
                className="btn sm"
                onClick={(e) => {
                  e.stopPropagation()
                  onRetry(entry.path)
                }}
              >
                {t.retry}
              </button>
              <button
                type="button"
                className="btn sm"
                onClick={(e) => {
                  e.stopPropagation()
                  onRemove(entry.path)
                }}
              >
                {t.remove}
              </button>
            </div>
          </div>
        ) : (
          <div className="vcard-meta">
            <span>{new Date(entry.addedAt).toLocaleString('zh-TW', { hour12: false })}</span>
            {entry.codec ? <span className="vcard-codec">{entry.codec.toUpperCase()}</span> : null}
          </div>
        )}
      </div>
    </article>
  )
}

export const VideoCard = React.memo(VideoCardView, (a, b) => sameCardEntry(a.entry, b.entry))
