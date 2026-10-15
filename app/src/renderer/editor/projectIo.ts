import { Project } from './project'

/** 專案加上檔案 id（`createProject` 不變；id 由 Provider 產生）。 */
export type ProjectWithId = Project & { id: string }

/** 產生 `p_<uuid>` 形式的檔名安全 id。 */
export function newProjectId(): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '')
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
  return `p_${uuid}`
}

/** 還原所需的 window.api 子集（方便測試注入）。 */
export interface RestoreApi {
  /** 讀取設定；失敗可由呼叫端轉成 null。 */
  getSettings: () => Promise<{ lastProjectId?: string | null } | null>
  /** 依 id 讀取專案；檔案不存在或損毀回 null。 */
  loadProject: (id: string) => Promise<Project | null>
}

/**
 * 啟動還原：依 `settings.lastProjectId` 讀回上次專案；
 * 設定讀取失敗／沒有紀錄／檔案不存在或損毀時一律回 null（改用新專案）。
 */
export async function restoreLastProject(api: RestoreApi): Promise<ProjectWithId | null> {
  try {
    const settings = await api.getSettings()
    const id = settings?.lastProjectId
    if (!id) return null
    const project = await api.loadProject(id)
    if (!project) return null
    return { ...project, id }
  } catch {
    return null
  }
}

export interface ValidationResult {
  /** 去重後、依片段順序排列的缺失來源路徑。 */
  missing: string[]
}

/**
 * 以 `exists`（主程序 `library:fileExists`）檢查專案所有來源是否存在；
 * 檢查失敗（IPC 錯誤）視為缺失。缺少來源的片段由 Task 13 的 UI 標示。
 */
export async function validateSources(
  project: Project,
  exists: (source: string) => Promise<boolean>
): Promise<ValidationResult> {
  const sources = [...new Set(project.items.map((item) => item.source))]
  const missing: string[] = []
  for (const source of sources) {
    let found = false
    try {
      found = await exists(source)
    } catch {
      found = false
    }
    if (!found) missing.push(source)
  }
  return { missing }
}

function normSource(p: string): string {
  return p.replace(/[\\]/g, '/').toLowerCase()
}

/**
 * 由缺失來源推得「缺失片段」id 集合（衍生值，不寫入專案檔）：
 * 來源路徑以斜線／大小寫不敏感比對；UI 以此標示警示並禁止預覽。
 */
export function missingItemIds(project: Project, missing: readonly string[]): ReadonlySet<string> {
  const gone = new Set(missing.map(normSource))
  return new Set(project.items.filter((i) => gone.has(normSource(i.source))).map((i) => i.id))
}
