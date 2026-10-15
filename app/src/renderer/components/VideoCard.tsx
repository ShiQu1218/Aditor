import React from 'react'
import { LibraryEntry } from '../../main/library'
import { i18n } from '../i18n/zh-TW'

interface VideoCardProps {
  entry: LibraryEntry
  onSelect: (entry: LibraryEntry) => void
  onToggleFavorite: (path: string, e: React.MouseEvent) => void
  onRemove: (path: string, e: React.MouseEvent) => void
  onRetry?: (path: string, e: React.MouseEvent) => void
}

function formatDuration(sec?: number): string {
  if (!sec) return '--:--'
  const s = Math.round(sec)
  const m = Math.floor(s / 60)
  const rem = s % 60
  const h = Math.floor(m / 60)
  const remM = m % 60
  if (h > 0) {
    return `${h}:${remM.toString().padStart(2, '0')}:${rem.toString().padStart(2, '0')}`
  }
  return `${remM}:${rem.toString().padStart(2, '0')}`
}

export function VideoCard({
  entry,
  onSelect,
  onToggleFavorite,
  onRemove,
  onRetry
}: VideoCardProps): JSX.Element {
  const filename = entry.path.split(/[/\\]/).pop() || entry.path

  return (
    <div
      onClick={() => onSelect(entry)}
      style={{
        backgroundColor: '#262833',
        borderRadius: 8,
        overflow: 'hidden',
        cursor: 'pointer',
        boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        transition: 'transform 0.15s, border-color 0.15s',
        border: '1px solid #363945',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative'
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'translateY(-2px)'
        e.currentTarget.style.borderColor = '#e13b30'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'translateY(0)'
        e.currentTarget.style.borderColor = '#363945'
      }}
    >
      {/* Thumbnail area */}
      <div
        style={{
          width: '100%',
          height: 140,
          backgroundColor: '#18191f',
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden'
        }}
      >
        {entry.thumb ? (
          <img
            src={`file://${entry.thumb.replace(/\\/g, '/')}`}
            alt={filename}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <div style={{ color: '#656877', fontSize: 13 }}>無縮圖</div>
        )}

        {/* Duration badge */}
        <div
          style={{
            position: 'absolute',
            bottom: 8,
            right: 8,
            backgroundColor: 'rgba(0,0,0,0.75)',
            color: '#fff',
            fontSize: 12,
            padding: '2px 6px',
            borderRadius: 4
          }}
        >
          {formatDuration(entry.durationSec)}
        </div>

        {/* Favorite button */}
        <button
          onClick={(e) => onToggleFavorite(entry.path, e)}
          style={{
            position: 'absolute',
            top: 8,
            left: 8,
            background: 'rgba(0,0,0,0.6)',
            border: 'none',
            borderRadius: '50%',
            width: 32,
            height: 32,
            cursor: 'pointer',
            color: entry.favorite ? '#ffcc00' : '#8c90a4',
            fontSize: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
          title={entry.favorite ? '取消收藏' : '加入收藏'}
        >
          ★
        </button>

        {/* Delete button */}
        <button
          onClick={(e) => onRemove(entry.path, e)}
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            background: 'rgba(0,0,0,0.6)',
            border: 'none',
            borderRadius: '50%',
            width: 32,
            height: 32,
            cursor: 'pointer',
            color: '#8c90a4',
            fontSize: 14,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
          title="移除影片"
        >
          ✕
        </button>
      </div>

      {/* Info area */}
      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: '#fff',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
          title={filename}
        >
          {filename}
        </div>

        {/* Badges / Stats */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {entry.status === 'done' ? (
            <>
              <span
                style={{
                  backgroundColor: '#e13b30',
                  color: '#fff',
                  fontSize: 11,
                  padding: '2px 6px',
                  borderRadius: 4,
                  fontWeight: 600
                }}
              >
                {i18n.library.badges.knock} {entry.counts?.knock ?? 0}
              </span>
              <span
                style={{
                  backgroundColor: '#3b82f6',
                  color: '#fff',
                  fontSize: 11,
                  padding: '2px 6px',
                  borderRadius: 4,
                  fontWeight: 600
                }}
              >
                {i18n.library.badges.assist} {entry.counts?.assist ?? 0}
              </span>
            </>
          ) : entry.status === 'analyzing' ? (
            <div style={{ width: '100%' }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 11,
                  color: '#38bdf8',
                  marginBottom: 4
                }}
              >
                <span>{i18n.library.status.analyzing}</span>
                <span>{Math.round((entry.progress || 0) * 100)}%</span>
              </div>
              <div style={{ width: '100%', height: 4, backgroundColor: '#363945', borderRadius: 2 }}>
                <div
                  style={{
                    width: `${Math.round((entry.progress || 0) * 100)}%`,
                    height: '100%',
                    backgroundColor: '#38bdf8',
                    borderRadius: 2
                  }}
                />
              </div>
            </div>
          ) : entry.status === 'pending' ? (
            <span style={{ fontSize: 11, color: '#94a3b8' }}>{i18n.library.status.pending}</span>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11, color: '#ef4444' }} title={entry.error}>
                {i18n.library.status.error}
              </span>
              {onRetry && (
                <button
                  onClick={(e) => onRetry(entry.path, e)}
                  style={{
                    fontSize: 10,
                    padding: '2px 6px',
                    backgroundColor: '#374151',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 3,
                    cursor: 'pointer'
                  }}
                >
                  重試
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
