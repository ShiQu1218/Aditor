export type BootPhase = 'idle' | 'restoring' | 'ready'

/**
 * Pure state machine for startup restoration (idle → restoring → ready). Events:
 * - `start()`: begin startup (load settings, then restore the last project).
 * - `settingsLoaded(raw)`: settings load succeeded or failed (failure is null; autosave defaults to on to avoid losing edits).
 * - `edit()`: the user has made an edit (apply/undo/redo/add/open).
 * - `restored(found)`: async restoration finished; return whether to apply the restored project.
 *
 * Apply restoration only once and only if the user has not edited. Otherwise keep the current project
 * and undo history so async restoration cannot overwrite changes made while it was pending.
 */
export class ProjectBoot {
  private _phase: BootPhase = 'idle'
  private _edited = false
  private _settingsKnown = false
  private _autosaveEnabled = true

  get phase(): BootPhase {
    return this._phase
  }
  get edited(): boolean {
    return this._edited
  }
  get settingsKnown(): boolean {
    return this._settingsKnown
  }
  get autosaveEnabled(): boolean {
    return this._autosaveEnabled
  }

  start(): void {
    if (this._phase === 'idle') this._phase = 'restoring'
  }

  edit(): void {
    this._edited = true
  }

  /** Pass settings.projectAutosave (non-boolean or load failure defaults to true); call again when the setting changes in the settings panel. */
  settingsLoaded(projectAutosave: unknown): boolean {
    this._settingsKnown = true
    this._autosaveEnabled = typeof projectAutosave === 'boolean' ? projectAutosave : true
    return this._autosaveEnabled
  }

  restored(found: boolean): boolean {
    const wasRestoring = this._phase === 'restoring'
    this._phase = 'ready'
    return wasRestoring && found && !this._edited
  }
}
