import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { Project, ProjectItem, createProject, deserializeProject } from './project'
import {
  ProjectWithId,
  createRefreshGate,
  missingItemIds,
  newProjectId,
  restoreLastProject,
  serializeProjectFile,
  validateSources
} from './projectIo'
import { ProjectSession, SaveState, createSessionIo } from './projectSession'
import { isEditorLocked } from './editorLock'

export type { SaveState }

export interface ProjectContextValue {
  /** 目前專案（含檔案 id）。 */
  project: ProjectWithId
  /** `project.items` 的捷徑。 */
  items: ProjectItem[]
  canUndo: boolean
  canRedo: boolean
  /** 套用一次異動（push 進 undo 歷史；缺 id 時沿用目前 id）。 */
  apply: (next: Project) => void
  undo: () => void
  redo: () => void
  /** 開新專案（新的 id 與空的 undo 歷史；第一次編輯前不寫入磁碟）。 */
  newProject: () => void
  /** 從磁碟開啟專案檔（`.apexproj.json`）；一律指派新的專案 id。 */
  openFile: () => Promise<void>
  /** 另存專案檔到磁碟（不含內部 id）；回傳實際儲存路徑（取消或失敗時 null，供 Toast 文案）。 */
  saveFile: () => Promise<string | null>
  /** 自動儲存狀態（Task 13 顯示用）。 */
  saveState: SaveState
  /** 最近一次成功寫入的 timestamp（ms）。 */
  lastSavedAt: number | null
  /** 開啟檔案時檢查到的缺失來源（Task 13 顯示用）。 */
  lastMissingSources: string[]
  /** 來源缺失的片段 id（由 lastMissingSources 衍生，不進專案檔；UI 警示且不可預覽）。 */
  missingItemIds: ReadonlySet<string>
}

const ProjectContext = createContext<ProjectContextValue | null>(null)

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext)
  if (!ctx) {
    throw new Error('useProject 必須在 ProjectProvider 內使用')
  }
  return ctx
}

function createInitialProject(): ProjectWithId {
  return { ...createProject('我的精華專案'), id: newProjectId() }
}

/**
 * 專案狀態的 React 外殼：所有邏輯（undo 歷史、去抖儲存、saveState、啟動還原排序）在
 * `ProjectSession`／`ProjectBoot`（純 TS、可單元測試）；這裡只負責訂閱並接上 IPC 與視窗事件：
 * - 啟動：先載入設定（得知 autosave 開關）再還原上次專案；還原不會蓋掉還原前的編輯
 * - 關閉：`beforeunload`／`pagehide` 以 sendSync 同步送出最新專案；main 關窗前也會要求 flush
 * - 開啟／另存檔案對話框
 */
export function ProjectProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const sessionRef = useRef<ProjectSession | null>(null)
  if (sessionRef.current === null) {
    sessionRef.current = new ProjectSession({ initial: createInitialProject(), io: createSessionIo(window.api) })
  }
  const session = sessionRef.current
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState)
  const [lastMissingSources, setLastMissingSources] = useState<string[]>([])

  // 啟動：先載入設定，再還原上次專案（結果由 session 決定是否套用）
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
      if (!session.restored(restored) || !restored) return
      // 還原的專案也要檢查來源是否仍存在（缺失片段警示且不可預覽）
      try {
        const { missing } = await validateSources(restored, (source) => api.library.fileExists(source))
        if (!cancelled && session.getState().project === restored) setLastMissingSources(missing)
      } catch {
        /* 檢查失敗不阻擋使用 */
      }
    }
    void boot()
    return () => {
      cancelled = true
    }
  }, [session])

  // 設定面板切換「專案自動儲存」時即時連動
  useEffect(() => {
    const off = window.api?.settings?.onChanged?.((s: unknown) => {
      const settings = s as { projectAutosave?: unknown } | null
      if (settings && typeof settings.projectAutosave === 'boolean') session.settingsLoaded(settings.projectAutosave)
    })
    return () => {
      off?.()
    }
  }, [session])

  // 關閉視窗：同步送出最新專案（阻塞到 main 寫完）；main 在 close 事件也會要求 flush 並等待 ack
  useEffect(() => {
    const flush = (): void => session.flushSync()
    window.addEventListener('beforeunload', flush)
    window.addEventListener('pagehide', flush)
    const offRequest = window.api?.projects?.onFlushRequest?.(() => {
      session.flushSync()
      window.api?.projects?.flushDone?.()
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
      // 匯出進行中（editorLock）：資料層一律拒絕異動，介面層另有 inert
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
        if (isEditorLocked()) return
        setLastMissingSources([])
        session.newProject()
      }
    }),
    [session]
  )

  const openFile = useMemo(
    () => async (): Promise<void> => {
      const api = window.api
      if (!api || isEditorLocked()) return
      const filePath = await api.project?.showOpenDialog?.()
      if (!filePath) return
      const content = await api.project?.load?.(filePath)
      if (typeof content !== 'string') {
        session.setSaveError()
        return
      }
      try {
        // 驗證形狀；id 由 session 指派新的（檔案內的 id 一律忽略）
        const parsed = deserializeProject(content)
        setLastMissingSources([])
        session.openProject(parsed)
        const opened = session.getState().project
        const { missing } = await validateSources(opened, (source) => api.library.fileExists(source))
        if (session.getState().project === opened) setLastMissingSources(missing)
      } catch {
        session.setSaveError()
      }
    },
    [session]
  )

  const saveFile = useMemo(
    () => async (): Promise<string | null> => {
      const api = window.api
      if (!api) return null
      const snapshot = session.getState().project
      const filePath = await api.project?.showSaveDialog?.(`${snapshot.name}.apexproj.json`)
      if (!filePath) return null
      session.setSaving()
      try {
        // 匯出檔不帶內部 id，兩份副本才不會共用同一個 id
        const ok = await api.project?.save?.(filePath, serializeProjectFile(snapshot))
        if (ok) session.setSaved()
        else session.setSaveError()
        return ok ? filePath : null
      } catch {
        session.setSaveError()
        return null
      }
    },
    [session]
  )

  // 視窗取回焦點：重新檢查來源檔（節流 2 秒），讓缺失標記不致過時
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
      openFile,
      saveFile,
      saveState: state.saveState,
      lastSavedAt: state.lastSavedAt,
      lastMissingSources,
      missingItemIds: missingIds
    }),
    [state, actions, openFile, saveFile, lastMissingSources, missingIds]
  )

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>
}
