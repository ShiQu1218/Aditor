import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { Project, ProjectItem, createProject } from './project'
import {
  ProjectWithId,
  createRefreshGate,
  missingItemIds,
  newProjectId,
  restoreLastProject,
  validateSources
} from './projectIo'
import { tr } from '../../shared/locale'
import { ProjectSession, SaveState, createSessionIo } from './projectSession'
import { isEditorLocked } from './editorLock'

export type { SaveState }

export interface ProjectContextValue {
  /** Current project, including its file id. */
  project: ProjectWithId
  /** Shortcut to `project.items`. */
  items: ProjectItem[]
  canUndo: boolean
  canRedo: boolean
  /** Apply one change (push it to undo history; reuse the current id when missing). */
  apply: (next: Project) => void
  undo: () => void
  redo: () => void
  /** Synchronously save the old project before creating a new one; keep the old project if saving fails. */
  newProject: () => boolean
  /** Autosave state (displayed by Task 13). */
  saveState: SaveState
  /** Timestamp (ms) of the most recent successful write. */
  lastSavedAt: number | null
  /** Project file was corrupted or created by a newer version during startup restoration (show a notice once). */
  restoreNotice: 'corrupt' | 'unsupported' | null
  /** Sources found missing when opening a file (displayed by Task 13). */
  lastMissingSources: string[]
  /** Clip ids with missing sources (derived from lastMissingSources and not stored in the project file; the UI warns and disables preview). */
  missingItemIds: ReadonlySet<string>
}

const ProjectContext = createContext<ProjectContextValue | null>(null)

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext)
  if (!ctx) {
    throw new Error('useProject must be used within a ProjectProvider')
  }
  return ctx
}

function createInitialProject(): ProjectWithId {
  return { ...createProject(tr('我的精華專案')), id: newProjectId() }
}

/**
 * React wrapper for project state: all logic (undo history, debounced saves, saveState, and startup restoration ordering) lives in
 * `ProjectSession`/`ProjectBoot` (plain TS and unit-testable); this component subscribes and connects IPC and window events:
 * - Startup: load settings (to learn whether autosave is enabled), then restore the last project; restoration does not overwrite earlier edits.
 * - Close: synchronously send the latest project with sendSync on `beforeunload`/`pagehide`; main also requests a flush before closing.
 */
export function ProjectProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const sessionRef = useRef<ProjectSession | null>(null)
  if (sessionRef.current === null) {
    sessionRef.current = new ProjectSession({ initial: createInitialProject(), io: createSessionIo(window.api) })
  }
  const session = sessionRef.current
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState)
  const [lastMissingSources, setLastMissingSources] = useState<string[]>([])
  const [restoreNotice, setRestoreNotice] = useState<'corrupt' | 'unsupported' | null>(null)

  // Startup: load settings before restoring the last project; the session decides whether to apply the result.
  useEffect(() => {
    let cancelled = false
    const api = window.api
    if (!api) {
      session.settingsLoaded(undefined)
      return
    }
    session.startBoot()
    const boot = async (): Promise<void> => {
      let settings: { projectAutosave?: unknown; lastProjectId?: string | null } | null = null
      try {
        settings = (await api.settings?.get()) ?? null
      } catch {
        settings = null
      }
      if (cancelled) return
      session.settingsLoaded(settings?.projectAutosave)

      const restored = await restoreLastProject({
        getSettings: async () => settings,
        loadProject: (id: string) => api.projects.load(id)
      })
      if (cancelled) return
      // The project file is corrupted or from a newer version; main preserved a backup, so only notify the user here (I12).
      if (!restored) {
        try {
          const err = (await api.projects.lastError?.()) as { kind?: string } | null
          if (!cancelled && (err?.kind === 'corrupt' || err?.kind === 'unsupported')) setRestoreNotice(err.kind)
        } catch {
          /* Missing notice support does not affect use. */
        }
      }
      if (cancelled) return
      if (!session.restored(restored) || !restored) return
      // Check that restored project sources still exist (warn about missing clips and disable preview).
      try {
        const { missing } = await validateSources(restored, (source) => api.library.fileExists(source))
        if (!cancelled && session.getState().project === restored) setLastMissingSources(missing)
      } catch {
        /* A failed check must not block use. */
      }
    }
    void boot()
    return () => {
      cancelled = true
    }
  }, [session])

  // Apply changes immediately when the settings panel toggles project autosave.
  useEffect(() => {
    const off = window.api?.settings?.onChanged?.((s: unknown) => {
      const settings = s as { projectAutosave?: unknown } | null
      if (settings && typeof settings.projectAutosave === 'boolean') session.settingsLoaded(settings.projectAutosave)
    })
    return () => {
      off?.()
    }
  }, [session])

  // On close, synchronously send the latest project and wait for main to finish writing; main also requests a flush and waits for its acknowledgment.
  useEffect(() => {
    const flush = (event: Event): void => {
      if (!session.flushSync() && event.type === 'beforeunload') {
        event.preventDefault()
        ;(event as BeforeUnloadEvent).returnValue = ''
      }
    }
    window.addEventListener('beforeunload', flush)
    window.addEventListener('pagehide', flush)
    const offRequest = window.api?.projects?.onFlushRequest?.(() => {
      const ok = session.flushSync()
      window.api?.projects?.flushDone?.(ok)
    })
    return () => {
      window.removeEventListener('beforeunload', flush)
      window.removeEventListener('pagehide', flush)
      offRequest?.()
      session.flushSync()
    }
  }, [session])

  const actions = useMemo(
    () => ({
      // While exporting (editorLock), the data layer rejects changes and the interface is also inert.
      apply: (next: Project) => {
        if (!isEditorLocked()) session.apply(next)
      },
      undo: () => {
        if (!isEditorLocked()) session.undo()
      },
      redo: () => {
        if (!isEditorLocked()) session.redo()
      },
      newProject: () => {
        if (isEditorLocked() || !session.newProject()) return false
        setLastMissingSources([])
        return true
      }
    }),
    [session]
  )

  // When the window regains focus, recheck source files (throttled to 2 seconds) so missing-source markers stay current.
  useEffect(() => {
    const gate = createRefreshGate(2000)
    let cancelled = false
    const onFocus = (): void => {
      const api = window.api
      const snapshot = session.getState().project
      if (!api?.library?.fileExists || snapshot.items.length === 0 || !gate()) return
      void validateSources(snapshot, (source) => api.library.fileExists(source))
        .then(({ missing }) => {
          if (!cancelled && session.getState().project === snapshot) setLastMissingSources(missing)
        })
        .catch(() => {})
    }
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
    }
  }, [session])

  const missingIds = useMemo(() => missingItemIds(state.project, lastMissingSources), [state.project, lastMissingSources])

  const value = useMemo<ProjectContextValue>(
    () => ({
      project: state.project,
      items: state.items,
      canUndo: state.canUndo,
      canRedo: state.canRedo,
      ...actions,
      saveState: state.saveState,
      lastSavedAt: state.lastSavedAt,
      restoreNotice,
      lastMissingSources,
      missingItemIds: missingIds
    }),
    [state, actions, lastMissingSources, missingIds, restoreNotice]
  )

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>
}
