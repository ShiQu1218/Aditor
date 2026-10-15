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

export interface ValidateOptions {
  /** 同時檢查的路徑數上限（預設 4）。 */
  concurrency?: number
  /** 單一路徑的逾時（ms，預設 3000）；逾時視為缺失，避免離線磁碟卡住載入。 */
  timeoutMs?: number
}

/** 逾時視為 false；保證不丟錯。 */
function existsWithTimeout(exists: (s: string) => Promise<boolean>, source: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    Promise.resolve()
      .then(() => exists(source))
      .then(
        (v) => resolve(v === true),
        () => resolve(false)
      )
      .finally(() => clearTimeout(timer))
  })
}

/**
 * 以 `exists`（主程序 `library:fileExists`）檢查專案所有來源是否存在；
 * 有限並行（預設 4）、單一路徑逾時（預設 3 秒）；檢查失敗（IPC 錯誤）或逾時視為缺失。
 * 缺少來源的片段由 Task 13 的 UI 標示。
 */
export async function validateSources(
  project: Project,
  exists: (source: string) => Promise<boolean>,
  opts: ValidateOptions = {}
): Promise<ValidationResult> {
  const sources = [...new Set(project.items.map((item) => item.source))]
  const limit = Math.max(1, opts.concurrency ?? 4)
  const timeoutMs = opts.timeoutMs ?? 3000
  const found: boolean[] = new Array(sources.length).fill(false)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < sources.length) {
      const i = next++
      found[i] = await existsWithTimeout(exists, sources[i], timeoutMs)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, sources.length) }, worker))
  return { missing: sources.filter((_, i) => !found[i]) }
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

/** 節流閘門：距上次放行不足 minMs 回 false（視窗取回焦點時重新檢查來源用）。 */
export function createRefreshGate(minMs: number, now: () => number = Date.now): () => boolean {
  let last = -Infinity
  return () => {
    const t = now()
    if (t - last < minMs) return false
    last = t
    return true
  }
}

/** 匯出成檔案（`.apexproj.json`）的內容：去掉內部 id，兩份副本才不會共用同一個 id。 */
export function serializeProjectFile(p: ProjectWithId): string {
  const { id: _id, ...rest } = p
  void _id
  return JSON.stringify(rest, null, 2)
}
