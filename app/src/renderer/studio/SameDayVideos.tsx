import React, { useEffect, useId, useRef, useState } from 'react'
import type { LibraryEntry } from '../../main/library'
import { formatTime } from '../../shared/time'
import { ChevronDown, ImageOff, AlertTriangle, Loader2 } from '../components/icons'
import { cardStatusText, thumbnailUrl } from '../library/cardLogic'
import { recordedTime, studioVideoTitle } from '../library/recordedTime'
import { useQueueItemState } from '../queue/QueueProvider'
import { useToast } from '../shell/ToastHost'
import { i18n } from '../i18n/zh-TW'
import { subscribeStudioSettings } from './studioSettings'
import { useStudioLibrary } from './useStudioLibrary'

const t = i18n.studio.sameDay
const normalize = (path: string): string => path.replace(/\\/g, '/').toLowerCase()

function SameDayCard({ entry, current, activeRef, onOpenVideo }: {
  entry: LibraryEntry; current: boolean; activeRef: React.Ref<HTMLButtonElement>; onOpenVideo: (path: string) => void
}): JSX.Element {
  const queueState = useQueueItemState(entry.path)
  const status = cardStatusText(entry, queueState)
  const card = i18n.library.card
  const meta = [
    ...(entry.status === 'done' && entry.counts ? [
      entry.counts.knock > 0 ? card.knockBadge.replace('{n}', String(entry.counts.knock)) : '',
      entry.counts.assist > 0 ? card.assistBadge.replace('{n}', String(entry.counts.assist)) : ''
    ] : []),
    entry.durationSec != null ? formatTime(entry.durationSec) : ''
  ].filter(Boolean).join(' · ')
  return (
    <button type="button" className="same-day-card" aria-current={current ? 'true' : undefined}
      ref={current ? activeRef : undefined} onClick={() => { if (!current) onOpenVideo(entry.path) }}>
      <span className="same-day-thumb">
        {entry.thumb ? <img src={thumbnailUrl(entry.thumb)} alt="" loading="lazy" decoding="async" /> : <ImageOff className="ic" aria-hidden="true" />}
      </span>
      <span className="same-day-details">
        <span className="same-day-title" title={entry.path}>{studioVideoTitle(entry.path)}</span>
        {meta && <span className="same-day-meta mono">{meta}</span>}
        {status && <span className={`same-day-status${entry.status === 'error' ? ' error' : ''}`}>
          {entry.status === 'error' ? <AlertTriangle className="ic sm" aria-hidden="true" />
            : entry.status === 'analyzing' ? <Loader2 className="ic sm" aria-hidden="true" /> : null}
          {status}
        </span>}
      </span>
    </button>
  )
}

/** 播放器上方的同日錄影列；偏好沿用工作室設定，切片交回原有的來源切換流程。 */
export function SameDayVideos({ videoPath, onOpenVideo }: { videoPath: string; onOpenVideo: (path: string) => void }): JSX.Element | null {
  const { entries, failed, retry } = useStudioLibrary()
  const [collapsed, setCollapsed] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  const toast = useToast()
  const activeRef = useRef<HTMLButtonElement>(null)
  const listId = useId()
  const headingId = useId()
  useEffect(() => subscribeStudioSettings(window.api, (settings) => setCollapsed(settings.sameDayVideosCollapsed)), [])
  const active = entries?.find((entry) => normalize(entry.path) === normalize(videoPath))
  const day = active ? new Date(recordedTime(active)) : null
  const videos = day ? entries!.filter((entry) => new Date(recordedTime(entry)).toDateString() === day.toDateString())
    .sort((a, b) => recordedTime(b) - recordedTime(a)) : []
  const currentPath = active?.path
  useEffect(() => {
    if (!collapsed) activeRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [currentPath, collapsed, videos.length])
  const toggle = async (): Promise<void> => {
    if (saving || collapsed === null) return
    const next = !collapsed
    setSaving(true)
    try {
      const result = await window.api.settings.set({ sameDayVideosCollapsed: next })
      if (!result?.settings || typeof result.settings.sameDayVideosCollapsed !== 'boolean') throw new Error('設定資料無效')
      setCollapsed(result.settings.sameDayVideosCollapsed)
      if (!result.persisted) toast({ message: t.saveFailed })
    } catch {
      toast({ message: t.saveFailed })
    } finally {
      setSaving(false)
    }
  }
  if (failed) return <div className="notice" role="alert">
    <span>{i18n.studio.libraryReadFailed}</span>
    <button type="button" className="btn-ghost" onClick={retry}>{i18n.studio.loadFailed.retry}</button>
  </div>
  if (!day) return null
  const date = `${day.getFullYear()}年${day.getMonth() + 1}月${day.getDate()}日`
  return (
    <section className="same-day-videos" aria-label={t.label}>
      <div className="same-day-head">
        <h2 id={headingId}>{date}<span className="dim">{t.count.replace('{n}', String(videos.length))}</span></h2>
        <button type="button" className="icon-btn" aria-label={collapsed ? t.expand : t.collapse}
          aria-expanded={!collapsed} aria-controls={listId} disabled={saving || collapsed === null} onClick={() => { void toggle() }}>
          <ChevronDown className="ic" aria-hidden="true" />
        </button>
      </div>
      <div id={listId} className="same-day-list" role="group" aria-labelledby={headingId} hidden={collapsed === true}>
        {!collapsed && videos.map((entry) => <SameDayCard key={entry.path} entry={entry} current={normalize(entry.path) === normalize(videoPath)} activeRef={activeRef} onOpenVideo={onOpenVideo} />)}
      </div>
    </section>
  )
}
