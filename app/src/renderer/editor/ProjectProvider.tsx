import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  Project,
  ProjectItem,
  createProject,
  deserializeProject,
  serializeProject
} from './project'
import { History } from './history'
import { ProjectWithId, missingItemIds, newProjectId, restoreLastProject, validateSources } from './projectIo'
import { useAutosave } from './useAutosave'

export type SaveState = 'saved' | 'saving' | 'error'

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
  /** 開新專案（新的 id 與空的 undo 歷史）。 */
  newProject: () => void
  /** 從磁碟開啟專案檔（`.apexproj.json`）。 */
  openFile: () => Promise<void>
  /** 另存專案檔到磁碟；回傳實際儲存路徑（取消或失敗時 null，供 Toast 文案）。 */
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
 * 專案狀態的唯一來源：undo 歷史＋去抖自動儲存（main 的 ProjectStore）＋
 * 啟動還原（settings.lastProjectId）與開啟／另存檔案對話框。
 * 自動儲存開關讀取 settings.projectAutosave，設定變更時即時連動。
 */
export function ProjectProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const [project, setProject] = useState<ProjectWithId>(createInitialProject)
  const projectRef = useRef<ProjectWithId>(project)
  const historyRef = useRef<History<ProjectWithId> | null>(null)
  if (historyRef.current === null) {
    historyRef.current = new History<ProjectWithId>(project)
  }

  const [autosaveEnabled, setAutosaveEnabled] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  const [lastMissingSources, setLastMissingSources] = useState<string[]>([])

  const commit = useCallback((next: ProjectWithId) => {
    projectRef.current = next
    setProject(next)
  }, [])

  // 自動儲存：寫入 ProjectStore 並記下 lastProjectId（下次啟動還原用）
  const saveSnapshot = useCallback(async (snapshot: ProjectWithId) => {
    const api = window.api
    if (!api?.projects) return
    setSaveState('saving')
    try {
      await api.projects.save(snapshot)
      await api.settings?.set({ lastProjectId: snapshot.id })
      setSaveState('saved')
      setLastSavedAt(Date.now())
    } catch {
      setSaveState('error')
    }
  }, [])

  useAutosave(project, { delayMs: 500, enabled: autosaveEnabled, save: saveSnapshot })

  // 啟動：讀取設定（autosave 開關）並還原上次專案
  useEffect(() => {
    let cancelled = false
    const boot = async (): Promise<void> => {
      const api = window.api
      if (!api) return
      try {
        const settings = await api.settings?.get()
        if (!cancelled) {
          setAutosaveEnabled(settings && typeof settings.projectAutosave === 'boolean' ? settings.projectAutosave : true)
        }
      } catch {
        if (!cancelled) setAutosaveEnabled(true)
      }

      const restored = await restoreLastProject({
        getSettings: async () => {
          try {
            return await api.settings.get()
          } catch {
            return null
          }
        },
        loadProject: (id: string) => api.projects.load(id)
      })
      if (cancelled || !restored) return
      historyRef.current = new History<ProjectWithId>(restored)
      projectRef.current = restored
      setProject(restored)
      setSaveState('saved')
      // 還原的專案也要檢查來源是否仍存在（缺失片段警示且不可預覽）
      try {
        const { missing } = await validateSources(restored, (source) => api.library.fileExists(source))
        if (!cancelled && projectRef.current === restored) setLastMissingSources(missing)
      } catch {
        /* 檢查失敗不阻擋使用 */
      }
    }
    void boot()
    return () => {
      cancelled = true
    }
  }, [])

  // 設定面板切換「專案自動儲存」時即時連動
  useEffect(() => {
    const off = window.api?.settings?.onChanged?.((s: unknown) => {
      const settings = s as { projectAutosave?: unknown } | null
      if (settings && typeof settings.projectAutosave === 'boolean') {
        setAutosaveEnabled(settings.projectAutosave)
      }
    })
    return () => {
      off?.()
    }
  }, [])

  const apply = useCallback(
    (next: Project) => {
      const current = projectRef.current
      const withId: ProjectWithId = {
        ...next,
        id: (next as Partial<ProjectWithId>).id ?? current.id
      }
      historyRef.current?.push(withId)
      commit(withId)
    },
    [commit]
  )

  const undo = useCallback(() => {
    const history = historyRef.current
    if (!history?.canUndo) return
    commit(history.undo())
  }, [commit])

  const redo = useCallback(() => {
    const history = historyRef.current
    if (!history?.canRedo) return
    commit(history.redo())
  }, [commit])

  const newProject = useCallback(() => {
    const fresh = createInitialProject()
    historyRef.current = new History<ProjectWithId>(fresh)
    setLastMissingSources([])
    setSaveState('saved')
    setLastSavedAt(null)
    commit(fresh)
  }, [commit])

  const openFile = useCallback(async () => {
    const api = window.api
    if (!api) return
    const filePath = await api.project?.showOpenDialog?.()
    if (!filePath) return
    const content = await api.project?.load?.(filePath)
    if (typeof content !== 'string') {
      setSaveState('error')
      return
    }
    try {
      const parsed = deserializeProject(content)
      const withId: ProjectWithId = {
        ...parsed,
        id: (parsed as Partial<ProjectWithId>).id || newProjectId()
      }
      const { missing } = await validateSources(withId, (source) => api.library.fileExists(source))
      historyRef.current = new History<ProjectWithId>(withId)
      setLastMissingSources(missing)
      setSaveState('saved')
      commit(withId)
    } catch {
      setSaveState('error')
    }
  }, [commit])

  const saveFile = useCallback(async (): Promise<string | null> => {
    const api = window.api
    if (!api) return null
    const snapshot = projectRef.current
    const filePath = await api.project?.showSaveDialog?.(`${snapshot.name}.apexproj.json`)
    if (!filePath) return null
    setSaveState('saving')
    try {
      const ok = await api.project?.save?.(filePath, serializeProject(snapshot))
      setSaveState(ok ? 'saved' : 'error')
      if (ok) setLastSavedAt(Date.now())
      return ok ? filePath : null
    } catch {
      setSaveState('error')
      return null
    }
  }, [])

  const missingIds = useMemo(() => missingItemIds(project, lastMissingSources), [project, lastMissingSources])

  const canUndo = historyRef.current?.canUndo ?? false
  const canRedo = historyRef.current?.canRedo ?? false

  const value = useMemo<ProjectContextValue>(
    () => ({
      project,
      items: project.items,
      canUndo,
      canRedo,
      apply,
      undo,
      redo,
      newProject,
      openFile,
      saveFile,
      saveState,
      lastSavedAt,
      lastMissingSources,
      missingItemIds: missingIds
    }),
    [
      project,
      canUndo,
      canRedo,
      apply,
      undo,
      redo,
      newProject,
      openFile,
      saveFile,
      saveState,
      lastSavedAt,
      lastMissingSources,
      missingIds
    ]
  )

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>
}
