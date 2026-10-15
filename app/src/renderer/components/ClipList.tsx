import React from 'react'
import { Clip } from '../../shared/types'
import { formatTime } from '../../shared/time'

interface ClipListProps {
  clips: Clip[]
  onPlayClip: (clip: Clip) => void
  onRemoveClip: (id: string) => void
}

export function ClipList({ clips, onPlayClip, onRemoveClip }: ClipListProps): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto', maxHeight: '100%' }}>
      {clips.length === 0 ? (
        <div style={{ color: '#64748b', fontSize: 13, textAlign: 'center', padding: 20 }}>
          尚未建立任何片段
        </div>
      ) : (
        clips.map((clip) => {
          const len = Math.max(0, clip.end - clip.start)
          const isAi = clip.origin === 'ai'

          return (
            <div
              key={clip.id}
              onClick={() => onPlayClip(clip)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 10px',
                backgroundColor: '#22242e',
                borderRadius: 6,
                cursor: 'pointer',
                border: '1px solid #303340',
                transition: 'background-color 0.1s'
              }}
            >
              {/* Origin badge */}
              <span
                style={{
                  fontSize: 10,
                  padding: '2px 5px',
                  borderRadius: 3,
                  backgroundColor: isAi ? '#38bdf8' : '#22c55e',
                  color: isAi ? '#000' : '#fff',
                  fontWeight: 600
                }}
              >
                {isAi ? 'AI' : '手動'}
              </span>

              {/* Time range */}
              <span style={{ fontSize: 12, fontFamily: 'monospace', color: '#fff' }}>
                {formatTime(clip.start)} - {formatTime(clip.end)}
              </span>

              {/* Duration */}
              <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 'auto' }}>
                {len.toFixed(1)}s
              </span>

              {/* Delete clip button */}
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onRemoveClip(clip.id)
                }}
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: '#ef4444',
                  cursor: 'pointer',
                  fontSize: 14,
                  padding: '0 4px'
                }}
                title="刪除片段"
              >
                ✕
              </button>
            </div>
          )
        })
      )}
    </div>
  )
}
