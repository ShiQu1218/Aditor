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
  /** 最近一次成功寫入的 timestamp（ms）。 */
  lastSavedAt: number | null
  /** 目前是否有尚未成功寫入的編輯（包含去抖等待中）。 */
  unsaved: boolean
}

/** 寫入通道：`save` 為一般 IPC；`saveSync` 為關閉視窗用的同步 IPC（回傳前 main 已寫入磁碟）。 */
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
 * 以 `window.api` 建立寫入通道。`lastProjectId` 由 main 在同一次 save／flushSync 內記錄，
 * 這裡不再另發設定 IPC（否則關閉前最後一次寫入會遺失）。回傳 false 視為失敗（丟錯）。
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
 * 專案狀態的純控制器（React 之外）：undo 歷史、去抖自動儲存、saveState、啟動還原排序。
 * Provider 只負責訂閱並把 IPC／視窗事件接進來。
 *
 * 自動儲存在設定載入前為 held（保留待寫但不寫），`settingsLoaded` 後依設定寫一次或丟棄；
 * 新增專案不寫入空檔（第一次編輯才寫）；啟動還原只在使用者尚未編輯時套用。
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

  /** 實際寫入；只有最新一次寫入的結果會更新 saveState（舊請求晚到不能蓋掉）。 */
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

  // ---- 啟動 ----

  startBoot(): void {
    this.boot.start()
  }

  /** 設定載入（或設定面板切換）後呼叫：決定自動儲存開關並放行／丟棄待寫內容。 */
  settingsLoaded(projectAutosave: unknown): void {
    const enabled = this.boot.settingsLoaded(projectAutosave)
    this.autosave.setEnabled(enabled)
    this.autosave.setHeld(false)
    this.commit()
  }

  /** 啟動還原結果；回傳是否已套用（使用者已編輯就保留目前專案與歷史）。 */
  restored(project: ProjectWithId | null): boolean {
    if (!this.boot.restored(project !== null) || !project) return false
    this.history = new History<ProjectWithId>(project)
    this.unsaved = false
    this.commit('saved', null)
    return true
  }

  // ---- 編輯 ----

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

  /** 新專案：先寫出舊專案待寫內容；空專案不落地，第一次編輯才寫。 */
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

  /** 關閉視窗：同步送出最新待寫專案（阻塞到 main 寫完）。 */
  flushSync(): boolean {
    this.autosave.cancelPending()
    if (!this.unsaved) return true
    // 即使自動儲存關閉、設定尚未載入或非同步儲存尚未完成，也要寫出最新內容。
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
