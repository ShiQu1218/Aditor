import React, { useEffect, useRef, useState } from 'react'
import { EventType } from '../../shared/types'
import { formatTime } from '../../shared/time'
import { i18n } from '../i18n/zh-TW'
import { CHIP_TYPES } from './chips'

interface AddEventDialogProps {
  /** 新增位置（目前播放頭，秒） */
  time: number
  onCancel: () => void
  onConfirm: (t: EventType) => void
}

/** Enter 是否由視窗層級處理器確認：按鈕上的 Enter 交給按鈕自己（取消鈕不得確認）。 */
export function enterConfirms(target: { tagName: string } | null): boolean {
  return !target || target.tagName.toUpperCase() !== 'BUTTON'
}

/** 新增事件對話框（M）：顯示播放頭時間，Enter 確認、Esc 取消。 */
export function AddEventDialog({ time, onCancel, onConfirm }: AddEventDialogProps): JSX.Element {
  const [type, setType] = useState<EventType>('knock')
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    boxRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing || e.keyCode === 229) return
      if (e.key === 'Enter') {
        if (!enterConfirms(e.target as HTMLElement | null)) return
        e.preventDefault()
        onConfirm(type)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [type, onCancel, onConfirm])

  const t = i18n.studio.addEvent
  const types = i18n.timeline.types
  return (
    <div className="add-event-host" onClick={onCancel}>
      <div
        ref={boxRef}
        className="add-event"
        role="dialog"
        aria-modal="true"
        aria-label={t.title.replace('{time}', formatTime(time))}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{t.title.replace('{time}', formatTime(time))}</h3>
        <fieldset className="add-event-types">
          <legend>{t.type}</legend>
          {CHIP_TYPES.map((key) => (
            <label key={key} className={`add-event-type chip-${key}`}>
              <input type="radio" name="addEventType" checked={type === key} onChange={() => setType(key)} />
              <span className="chip-dot" aria-hidden="true" />
              <span>{(types as Record<string, string>)[key] ?? key}</span>
            </label>
          ))}
        </fieldset>
        <div className="add-event-actions">
          <span className="dim">{t.hint}</span>
          <div className="spacer" />
          <button type="button" className="btn-ghost" onClick={onCancel}>
            {t.cancel}
          </button>
          <button type="button" className="btn-accent" onClick={() => onConfirm(type)}>
            {t.confirm}
          </button>
        </div>
      </div>
    </div>
  )
}
