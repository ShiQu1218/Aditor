export type BootPhase = 'idle' | 'restoring' | 'ready'

/**
 * 啟動還原的純狀態機（idle → restoring → ready）。事件：
 * - `start()`：開始啟動流程（先載入設定，再還原上次專案）
 * - `settingsLoaded(raw)`：設定載入完成／失敗（失敗＝null，自動儲存預設開啟，寧可多存不漏存）
 * - `edit()`：使用者已動手（apply／undo／redo／新增／開檔）
 * - `restored(found)`：非同步還原回來了；回傳是否應套用還原的專案
 *
 * 規則：還原結果只在「使用者尚未編輯」時套用（只套用一次）；已編輯就保留目前專案、
 * 不動 undo 歷史，避免非同步還原蓋掉使用者在還原完成前做的修改。
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

  /** 傳入 settings.projectAutosave（非布林或載入失敗＝true）；之後設定面板切換也可再次呼叫。 */
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
