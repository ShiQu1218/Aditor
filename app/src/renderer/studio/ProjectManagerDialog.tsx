import React, { useCallback, useEffect, useRef, useState } from 'react'
import { i18n } from '../i18n'
import { useFocusTrap } from '../a11y/useFocusTrap'

/** Mirrors `ProjectListEntry` from the main process (summary of a stored project). */
export interface StoredProjectSummary {
  id: string
  name: string
  updatedAt: number
  items: number
}

interface ProjectManagerDialogProps {
  /** Id of the project being edited: it cannot be deleted, renamed here, or reopened. */
  currentId: string
  onClose: () => void
  /** Switch to a stored project; resolves true when the switch happened (the dialog then closes). */
  onOpen: (id: string) => Promise<boolean>
}

type RowAction = { kind: 'rename'; id: string; draft: string } | { kind: 'remove'; id: string } | null

/** Lists every stored project and lets the user open, rename, or delete the ones that are not in use. */
export function ProjectManagerDialog({ currentId, onClose, onOpen }: ProjectManagerDialogProps): JSX.Element {
  const dlg = i18n.studio.projectManagerDlg
  const boxRef = useRef<HTMLDivElement>(null)
  const [entries, setEntries] = useState<StoredProjectSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [action, setAction] = useState<RowAction>(null)
  const [busy, setBusy] = useState(false)
  const actionRef = useRef(action)
  actionRef.current = action

  const refresh = useCallback(async () => {
    try {
      const list = (await window.api.projects.list()) as StoredProjectSummary[]
      setEntries(list)
    } catch {
      setError(dlg.loadFailed)
      setEntries([])
    }
  }, [dlg.loadFailed])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Esc first backs out of an inline rename/delete prompt, and only then closes the dialog.
  useFocusTrap(boxRef, {
    onEscape: () => {
      if (actionRef.current) setAction(null)
      else onClose()
    }
  })

  const run = async (task: () => Promise<boolean>, failure: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      if (!(await task())) setError(failure)
    } catch {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }

  const open = (id: string): Promise<void> =>
    run(async () => {
      const ok = await onOpen(id)
      if (ok) onClose()
      return ok
    }, dlg.openFailed)

  const commitRename = (id: string, draft: string): Promise<void> =>
    run(async () => {
      const ok = (await window.api.projects.rename(id, draft)) === true
      if (ok) {
        setAction(null)
        await refresh()
      }
      return ok
    }, dlg.renameFailed)

  const commitRemove = (id: string): Promise<void> =>
    run(async () => {
      await window.api.projects.remove(id)
      setAction(null)
      await refresh()
      return true
    }, dlg.removeFailed)

  return (
    <div className="np-host" onClick={onClose}>
      <div
        ref={boxRef}
        className="np-dlg pm-dlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pm-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="pm-title">{dlg.title}</h3>
        {error && (
          <div className="pm-error" role="alert">
            {error}
          </div>
        )}
        {entries === null && <div className="sub">{dlg.loading}</div>}
        {entries !== null && entries.length === 0 && <div className="sub">{dlg.empty}</div>}
        {entries !== null && entries.length > 0 && (
          <ul className="pm-list">
            {entries.map((entry) => {
              const isCurrent = entry.id === currentId
              const renaming = action?.kind === 'rename' && action.id === entry.id ? action : null
              const removing = action?.kind === 'remove' && action.id === entry.id
              return (
                <li key={entry.id} className={`pm-row${isCurrent ? ' current' : ''}`}>
                  <div className="pm-main">
                    {renaming ? (
                      <input
                        className="pm-input"
                        aria-label={dlg.nameLabel}
                        value={renaming.draft}
                        autoFocus
                        maxLength={120}
                        onChange={(e) => setAction({ kind: 'rename', id: entry.id, draft: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.nativeEvent.isComposing) return
                          if (e.key === 'Enter' && renaming.draft.trim()) void commitRename(entry.id, renaming.draft)
                        }}
                      />
                    ) : (
                      <span className="pm-name">{entry.name}</span>
                    )}
                    {isCurrent && <span className="pm-badge">{dlg.current}</span>}
                    <span className="pm-meta">
                      {dlg.clips.replace('{n}', String(entry.items))} · {new Date(entry.updatedAt).toLocaleString()}
                    </span>
                  </div>
                  <div className="pm-actions">
                    {removing ? (
                      <>
                        <span className="pm-confirm">{dlg.removeConfirm.replace('{name}', entry.name)}</span>
                        <button type="button" className="btn-ghost sm" disabled={busy} onClick={() => setAction(null)}>
                          {dlg.cancel}
                        </button>
                        <button type="button" className="btn-accent sm" disabled={busy} onClick={() => void commitRemove(entry.id)}>
                          {dlg.removeYes}
                        </button>
                      </>
                    ) : renaming ? (
                      <>
                        <button type="button" className="btn-ghost sm" disabled={busy} onClick={() => setAction(null)}>
                          {dlg.cancel}
                        </button>
                        <button
                          type="button"
                          className="btn-accent sm"
                          disabled={busy || !renaming.draft.trim()}
                          onClick={() => void commitRename(entry.id, renaming.draft)}
                        >
                          {dlg.save}
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" className="btn-accent sm" disabled={busy || isCurrent} onClick={() => void open(entry.id)}>
                          {dlg.open}
                        </button>
                        <button
                          type="button"
                          className="btn-ghost sm"
                          disabled={busy || isCurrent}
                          onClick={() => setAction({ kind: 'rename', id: entry.id, draft: entry.name })}
                        >
                          {dlg.rename}
                        </button>
                        <button
                          type="button"
                          className="btn-ghost sm"
                          disabled={busy || isCurrent}
                          onClick={() => setAction({ kind: 'remove', id: entry.id })}
                        >
                          {dlg.remove}
                        </button>
                      </>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        <div className="foot">
          <button type="button" className="btn-ghost" onClick={onClose}>
            {dlg.close}
          </button>
        </div>
      </div>
    </div>
  )
}
