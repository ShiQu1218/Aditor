import React, { useId, useRef } from 'react'
import { useFocusTrap } from '../a11y/useFocusTrap'
import { Trash2 } from '../components/icons'

export interface RemoveChoiceDialogProps {
  /** Dialog title. */
  title: string
  /** Main sentence: what is being removed and what the two choices do. */
  message: string
  /** Optional extra sentence (for example the note about recording source files). */
  note?: string
  /** Label of the destructive button (delete the source file). */
  deleteLabel: string
  /** Label of the button that removes the entry but keeps the source file. */
  removeLabel: string
  /** Label of the cancel button. */
  cancelLabel: string
  /** Delete the source file and remove the entry from the library. */
  onDeleteSource: () => void
  /** Remove the entry from the library and keep the source file. */
  onRemoveOnly: () => void
  /** Close the dialog without removing anything. */
  onCancel: () => void
}

/**
 * Ask what to do with the source file of an imported video (delete the file, or only drop the library entry).
 * Esc and a click on the scrim cancel; the focus stays inside the dialog and starts on Cancel, so the destructive
 * choice is never the default.
 */
export function RemoveChoiceDialog({
  title,
  message,
  note,
  deleteLabel,
  removeLabel,
  cancelLabel,
  onDeleteSource,
  onRemoveOnly,
  onCancel
}: RemoveChoiceDialogProps): JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const messageId = useId()
  const noteId = useId()
  useFocusTrap(boxRef, { onEscape: onCancel, initialFocus: () => cancelRef.current })
  return (
    <div
      className="lib-dlg-scrim"
      onMouseDown={(e) => {
        // Only a click on the scrim itself cancels; clicks inside the dialog bubble up from the box.
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        ref={boxRef}
        className="lib-dlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={note ? `${messageId} ${noteId}` : messageId}
      >
        <h3 id={titleId}>{title}</h3>
        <p id={messageId}>{message}</p>
        {note ? <p id={noteId} className="lib-dlg-note">{note}</p> : null}
        <div className="lib-dlg-foot">
          <button type="button" className="lib-btn danger" onClick={onDeleteSource}>
            <Trash2 className="ic sm" />
            {deleteLabel}
          </button>
          <button type="button" className="lib-btn" onClick={onRemoveOnly}>
            {removeLabel}
          </button>
          <button type="button" className="lib-btn" ref={cancelRef} onClick={onCancel}>
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
