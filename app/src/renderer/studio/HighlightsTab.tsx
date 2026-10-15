import React, { useEffect, useRef, useState } from 'react'
import type { Clip, EngineEvent } from '../../shared/types'
import { formatTime } from '../../shared/time'
import { suggestionCount } from '../../shared/clips'
import { totalDuration, type Project } from '../editor/project'
import { i18n } from '../i18n/zh-TW'
import { HighlightCard } from './HighlightCard'

export interface HighlightsTabProps {
  clips: Clip[]
  events: EngineEvent[]
  /** 作用中卡片（keymap Enter／Delete／↑↓ 的目標） */
  activeId: string | null
  onActiveChange: (id: string | null) => void
  onPreview: (clip: Clip) => void
  onAccept: (clip: Clip) => void
  onSkip: (clip: Clip) => void
  onRestore: (clip: Clip) => void
  onRemove: (clip: Clip) => void
  /** 空狀態的〔調整 AI 參數〕 */
  onTuneParams: () => void
  project: Project
  onAddAll: () => void
}

/**
 * 精華分頁（spec §3.2.3）：精簡／大圖切換、卡片清單（role=list、roving tabindex）、
 * 底欄「專案已有 N 段 · 總長」＋〔全部加入 Ctrl E〕。
 */
export function HighlightsTab({
  clips,
  events,
  activeId,
  onActiveChange,
  onPreview,
  onAccept,
  onSkip,
  onRestore,
  onRemove,
  onTuneParams,
  project,
  onAddAll
}: HighlightsTabProps): JSX.Element {
  const t = i18n.studio.hl
  const [big, setBig] = useState(false)
  const cardRefs = useRef(new Map<string, HTMLDivElement>())

  // 作用中卡片變更時移動焦點：只在焦點原本就落在清單內、或尚未聚焦（body）時，
  // 避免 ↑↓ 移動或首張自動對焦時搶走時間軸／播放器的焦點。
  useEffect(() => {
    if (!activeId) return
    const el = cardRefs.current.get(activeId)
    if (!el) return
    const focused = document.activeElement as HTMLElement | null
    const inHl = typeof focused?.closest === 'function' && focused.closest('[data-zone="hl"]') !== null
    if (inHl || focused === document.body || focused === null) el.focus()
  }, [activeId])

  const pending = suggestionCount(clips)

  return (
    <div className="hl-tab" data-zone="hl" role="tabpanel" aria-label={i18n.studio.tabs.hl}>
      <div className="hl-list-head">
        <span className="dim">{t.pending.replace('{n}', String(pending))}</span>
        <div className="hl-view">
          <button
            type="button"
            className={`hl-view-btn${big ? '' : ' on'}`}
            aria-pressed={!big}
            onClick={() => setBig(false)}
          >
            {t.compact}
          </button>
          <button
            type="button"
            className={`hl-view-btn${big ? ' on' : ''}`}
            aria-pressed={big}
            onClick={() => setBig(true)}
          >
            {t.large}
          </button>
        </div>
      </div>
      <p className="hl-hint dim">{t.focusHint}</p>

      <div className="hl-scroll">
        {clips.length === 0 ? (
          <div className="hl-empty">
            <p>{t.empty}</p>
            <button type="button" className="btn-ghost" onClick={onTuneParams}>
              {t.tuneParams}
            </button>
            <p className="dim">{t.emptyHint}</p>
          </div>
        ) : (
          <div className="hl-list" role="list">
            {clips.map((c) => (
              <HighlightCard
                key={c.id}
                ref={(el) => {
                  if (el) cardRefs.current.set(c.id, el)
                  else cardRefs.current.delete(c.id)
                }}
                clip={c}
                events={events}
                big={big}
                active={c.id === activeId}
                onSelect={(clip) => {
                  onActiveChange(clip.id)
                  onPreview(clip)
                }}
                onPreview={onPreview}
                onAccept={onAccept}
                onSkip={onSkip}
                onRestore={onRestore}
                onRemove={onRemove}
              />
            ))}
          </div>
        )}
      </div>

      <div className="hl-foot">
        <span className="dim mono">
          {t.projectSummary
            .replace('{n}', String(project.items.length))
            .replace('{time}', formatTime(totalDuration(project)))}
        </span>
        <button type="button" className="btn-accent" disabled={pending === 0} onClick={onAddAll}>
          {i18n.studio.track.addAll} <kbd>{i18n.studio.track.addAllKey}</kbd>
        </button>
      </div>
    </div>
  )
}
