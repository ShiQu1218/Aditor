import { Project, ProjectItem } from './project'
import { History } from './history'
import { ProjectBoot } from './projectBoot'
import { AutosaveController } from './useAutosave'
import { ProjectWithId, newProjectId } from './projectIo'
import { tr } from '../../shared/locale'

export type SaveState = 'saved' | 'pending' | 'saving' | 'error'

export interface SessionState {
  project: ProjectWithId
  items: ProjectItem[]
  canUndo: boolean
  canRedo: boolean
  saveState: SaveState
/** Timestamp (ms) of the most recent successful write. */
  lastSavedAt: number | null
/** Whether any edits have not been written successfully yet (including edits waiting for debounce). */
  unsaved: boolean
}

/** Write channel: `save` uses regular IPC; `saveSync` is synchronous IPC for window close (main writes to disk before returning). */
export interface SessionIo {
  save(p: ProjectWithId): Promise<unknown>
  saveSync(p: ProjectWithId): void
}

interface ProjectsApi {
  projects?: {
    save?: (p: unknown) => Promise<unknown>
    flushSync?: (p: unknown) => boolean
  }
}

/**
 * Build the write channel from `window.api`. Main records `lastProjectId` during the same save/flushSync call,
 * so this code must not send a separate settings IPC (the final write could otherwise be lost on close). A false return is treated as failure (throws).
 */
export function createSessionIo(api: ProjectsApi | undefined): SessionIo {
  return {
    async save(p) {
      if (!api?.projects?.save) return
      if ((await api.projects.save(p)) === false) throw new Error(tr('儲存專案失敗'))
    },
    saveSync(p) {
      if (!api?.projects?.flushSync) return
      if (api.projects.flushSync(p) === false) throw new Error(tr('儲存專案失敗'))
    }
  }
}

export interface SessionOptions {
  initial: ProjectWithId
  io: SessionIo
  delayMs?: number
  newId?: () => string
  now?: () => number
}

/**
 * Pure controller for project state (outside React): undo history, debounced autosave, saveState, and startup restoration ordering.
 * The Provider only subscribes and connects IPC and window events.
 *
 * Before settings load, autosave is held (retain pending writes without writing); after `settingsLoaded`, write or discard them based on the setting.
 * A new project does not create an empty file (write after the first edit); apply startup restoration only if the user has not edited.
 */
export class ProjectSession {
  private io: SessionIo
  private newId: () => string
  private now: () => number
  private history: History<ProjectWithId>
  private boot = new ProjectBoot()
  private autosave: AutosaveController<ProjectWithId>
  private listeners = new Set<() => void>()
  private writeSeq = 0
  private state: SessionState
  private unsaved = false

  constructor(opts: SessionOptions) {
    this.io = opts.io
    this.newId = opts.newId ?? newProjectId
    this.now = opts.now ?? Date.now
    this.history = new History<ProjectWithId>(opts.initial)
    this.autosave = new AutosaveController<ProjectWithId>({
      delayMs: opts.delayMs ?? 500,
      held: true,
      save: (p) => this.write(p),
      saveSync: (p) => this.io.saveSync(p)
    })
    this.state = this.snapshot('saved', null)
  }

  getState = (): SessionState => this.state

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  private snapshot(saveState: SaveState, lastSavedAt: number | null): SessionState {
    const project = this.history.current
    return {
      project,
      items: project.items,
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
      saveState,
      lastSavedAt,
      unsaved: this.unsaved
    }
  }

  private commit(saveState = this.state.saveState, lastSavedAt = this.state.lastSavedAt): void {
    this.state = this.snapshot(saveState, lastSavedAt)
    for (const cb of [...this.listeners]) cb()
  }

/** Perform the write; only the latest write may update saveState (a late older request cannot overwrite it). */
  private write(p: ProjectWithId): void {
    const seq = ++this.writeSeq
    this.commit('saving')
    let result: Promise<unknown>
    try {
      result = this.io.save(p)
    } catch (err) {
      result = Promise.reject(err)
    }
    void result.then(
      () => {
        if (seq === this.writeSeq) {
          this.unsaved = false
          this.commit('saved', this.now())
        }
      },
      () => {
        if (seq === this.writeSeq) this.commit('error')
      }
    )
  }

// ---- Startup ----

  startBoot(): void {
    this.boot.start()
  }

/** Call after settings load or a settings-panel change to set autosave and release or discard pending writes. */
  settingsLoaded(projectAutosave: unknown): void {
    const enabled = this.boot.settingsLoaded(projectAutosave)
    this.autosave.setEnabled(enabled)
    this.autosave.setHeld(false)
    this.commit()
  }

/** Handle startup restoration; return whether it was applied (keep the current project and history if the user has edited). */
  restored(project: ProjectWithId | null): boolean {
    if (!this.boot.restored(project !== null) || !project) return false
    this.history = new History<ProjectWithId>(project)
    this.unsaved = false
    this.commit('saved', null)
    return true
  }

// ---- Editing ----

  apply(next: Project): void {
    this.boot.edit()
    const withId: ProjectWithId = { ...next, id: (next as Partial<ProjectWithId>).id ?? this.history.current.id }
    this.history.push(withId)
    this.markEdited()
    this.commit('pending')
    this.autosave.update(withId)
  }

  undo(): void {
    if (!this.history.canUndo) return
    this.boot.edit()
    const p = this.history.undo()
    this.markEdited()
    this.commit('pending')
    this.autosave.update(p)
  }

  redo(): void {
    if (!this.history.canRedo) return
    this.boot.edit()
    const p = this.history.redo()
    this.markEdited()
    this.commit('pending')
    this.autosave.update(p)
  }

/** New project: write pending content for the old project first; do not persist an empty project until its first edit. */
  newProject(): boolean {
    if (!this.flushSync()) return false
    this.boot.edit()
    this.history = new History<ProjectWithId>({ ...emptyProject(), id: this.newId() })
    this.unsaved = false
    this.commit('saved', null)
    return true
  }

  private markEdited(): void {
    this.unsaved = true
    this.writeSeq++
  }

/** On window close, synchronously send the latest pending project and wait for main to finish writing it. */
  flushSync(): boolean {
    this.autosave.cancelPending()
    if (!this.unsaved) return true
// Write the latest content even when autosave is off, settings have not loaded, or an async save is still pending.
    this.writeSeq++
    try {
      this.io.saveSync(this.history.current)
      this.unsaved = false
      this.commit('saved', this.now())
      return true
    } catch {
      this.commit('error')
      return false
    }
  }

  dispose(): void {
    this.autosave.dispose()
    this.listeners.clear()
  }
}

function emptyProject(): Project {
  return { version: 1, name: tr('我的精華專案'), items: [] }
}
