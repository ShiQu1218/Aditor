import React, { forwardRef } from 'react'
import type { Clip, EngineEvent } from '../../shared/types'
import { formatTime } from '../../shared/time'
import { Check, Play, Plus, Undo2 } from '../components/icons'
import { i18n } from '../i18n/zh-TW'
import { clipEventGlyphs, clipTitle } from './highlights'

export interface HighlightCardProps {
  clip: Clip
  /** 目前影片事件（供標題計數與字形列） */
  events: EngineEvent[]
  /** 大圖模式（16:9 縮圖卡） */
  big: boolean
  /** 作用中卡片（roving tabindex） */
  active: boolean
  /** 點卡片＝預覽並設為作用中 */
  onSelect: (clip: Clip) => void
  onPreview: (clip: Clip) => void
  onAccept: (clip: Clip) => void
  onSkip: (clip: Clip) => void
  onRestore: (clip: Clip) => void
  onRemove: (clip: Clip) => void
  /** 焦點進入卡片（含內部按鈕）時設為作用中（不預覽、不 seek） */
  onFocusCard: (clip: Clip) => void
}

/**
 * 精華卡片（spec §3.2.3）：精簡＝128×84 縮圖＋文字；大圖＝16:9。
 * 列表列本身不可用 `<button>`（keymap 規則）——以 div＋roving tabindex 實作。
 */
export const HighlightCard = forwardRef<HTMLDivElement, HighlightCardProps>(function HighlightCard(
  { clip, events, big, active, onSelect, onPreview, onAccept, onSkip, onRestore, onRemove, onFocusCard },
  ref
) {
  const t = i18n.studio.hl
  const status = clip.status ?? 'accepted'
  const title = clipTitle(clip, events)
  const { glyphs, overflow } = clipEventGlyphs(clip, events)
  const len = Math.max(0, clip.end - clip.start)
  const badge =
    clip.origin === 'manual' ? t.badgeManual : status === 'suggested' ? t.badgeSuggested : t.badgeAccepted
  const timeLabel = `${formatTime(clip.start)}–${formatTime(clip.end)}`
  // roving tabindex：只有作用中卡片的內部按鈕在 Tab 順序內（其餘仍可用滑鼠點擊）
  const inner = active ? 0 : -1

  return (
    <div
      ref={ref}
      role="listitem"
      tabIndex={active ? 0 : -1}
      className={`hl-card${big ? ' big' : ''}${status === 'skipped' ? ' skipped' : ''}${active ? ' active' : ''}`}
      aria-label={`${title}，${timeLabel}`}
      data-clip-id={clip.id}
      onClick={() => onSelect(clip)}
      onFocus={() => onFocusCard(clip)}
    >
      <div className="hl-thumb" aria-hidden="true">
        <span className={`hl-badge ${clip.origin === 'manual' ? 'manual' : status}`}>{badge}</span>
        <span className="hl-dur mono">{formatTime(len)}</span>
      </div>

      <div className="hl-body">
        <div className="hl-head">
          <span className="hl-title">{title}</span>
          <span className="hl-time mono dim">{timeLabel}</span>
        </div>
        {clip.stale && <div className="hl-sub dim">{t.stale}</div>}
        <div className="hl-glyphs" aria-hidden="true">
          {glyphs.map((g, i) => (
            <span key={i} className={`hl-glyph${g.counted ? '' : ' uncounted'}`} data-type={g.type} />
          ))}
          {overflow > 0 && <span className="hl-more dim">+{overflow}</span>}
        </div>

        <div className="hl-actions">
          {status === 'suggested' && (
            <>
              <button
                type="button"
                tabIndex={inner}
                className="icon-btn hl-preview"
                aria-label={t.preview}
                onClick={(e) => {
                  e.stopPropagation()
                  onPreview(clip)
                }}
              >
                <Play className="ic sm" />
              </button>
              <div className="hl-actions-spacer" />
              <button
                type="button"
                tabIndex={inner}
                className="btn-ghost hl-skip"
                onClick={(e) => {
                  e.stopPropagation()
                  onSkip(clip)
                }}
              >
                {t.skip}
              </button>
              <button
                type="button"
                tabIndex={inner}
                className="btn-accent hl-accept"
                onClick={(e) => {
                  e.stopPropagation()
                  onAccept(clip)
                }}
              >
                <Plus className="ic sm" />
                {t.accept}
              </button>
            </>
          )}

          {status === 'accepted' && (
            <>
              <span className="hl-accepted">
                <Check className="ic sm" />
                {t.accepted}
              </span>
              <div className="hl-actions-spacer" />
              <button
                type="button"
                tabIndex={inner}
                className="btn-ghost hl-remove"
                onClick={(e) => {
                  e.stopPropagation()
                  onRemove(clip)
                }}
              >
                {t.remove}
              </button>
            </>
          )}

          {status === 'skipped' && (
            <button
              type="button"
              tabIndex={inner}
              className="btn-ghost hl-restore"
              onClick={(e) => {
                e.stopPropagation()
                onRestore(clip)
              }}
            >
              <Undo2 className="ic sm" />
              {t.restore}
            </button>
          )}
        </div>
      </div>
    </div>
  )
})
