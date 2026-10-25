import { useEffect, useId, useRef, useState } from 'react'
import { useFocusTrap } from '../a11y/useFocusTrap'
import { EventType } from '../../shared/types'
import { formatTime } from '../../shared/time'
import { i18n } from '../i18n'
import { CHIP_TYPES } from './chips'

interface AddEventDialogProps {
  /** Position for the new event (current playhead, in seconds). */
  time: number
  onCancel: () => void
  onConfirm: (t: EventType) => void
  /** Types offered for this video's game (defaults to Apex's). */
  types?: EventType[]
}

/** Whether Enter is handled by the window-level handler; buttons handle their own Enter (the cancel button must not confirm). */
export function enterConfirms(target: { tagName: string } | null): boolean {
  return !target || target.tagName.toUpperCase() !== 'BUTTON'
}

/** Add-event dialog (M): shows the playhead time, Enter confirms, and Esc cancels. */
export function AddEventDialog({ time, onCancel, onConfirm, types: offered = CHIP_TYPES }: AddEventDialogProps): JSX.Element {
  const [type, setType] = useState<EventType>(offered[0])
  const boxRef = useRef<HTMLDivElement>(null)

  const titleId = useId()
  // Focus trap, Esc cancellation, and focus restoration on close (shared a11y/focusTrap); focus the dialog on open so Enter confirms immediately.
  useFocusTrap(boxRef, { onEscape: onCancel, initialFocus: () => boxRef.current })

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing || e.keyCode === 229) return
      if (e.key === 'Enter') {
        if (!enterConfirms(e.target as HTMLElement | null)) return
        e.preventDefault()
        onConfirm(type)
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
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id={titleId}>{t.title.replace('{time}', formatTime(time))}</h3>
        <fieldset className="add-event-types">
          <legend>{t.type}</legend>
          {offered.map((key) => (
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
