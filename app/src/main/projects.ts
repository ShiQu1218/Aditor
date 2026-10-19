import fs from 'fs'
import path from 'path'
import { ProjectItem, projectShapeError } from '../renderer/editor/project'
import { tr } from '../shared/locale'

/** 磁碟上的專案：renderer 的 Project 加上檔案 id。 */
export interface StoredProject {
  id: string
  version: 1
  name: string
  items: ProjectItem[]
}

/** `list()` 回傳的摘要（不含全部片段）。 */
export interface ProjectListEntry {
  id: string
  name: string
  updatedAt: number
  items: number
}

/** 專案 id 僅允許檔名安全字元（`p_` 開頭由 renderer 產生）。 */
const ID_RE = /^[A-Za-z0-9_-]+$/
/** 看起來合法、實際是 `String(undefined)` 之類的壞值。 */
const BAD_IDS = new Set(['undefined', 'null', 'NaN'])
/** 每個專案最多保留的損毀備份數 */
const MAX_BACKUPS = 3

export type ProjectErrorKind = 'save' | 'corrupt' | 'transient' | 'unsupported'

function isValidId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && ID_RE.test(id) && !BAD_IDS.has(id)
}

/**
 * `%APPDATA%\ApexHighlighter\projects\<id>.json` 的讀寫者。
 * 寫入走暫存檔＋fsync＋rename（原子替換，失敗保留上一版）；
 * 讀取：只有 JSON／格式錯誤才把檔案改名為 `<id>.bak.<時間戳>.json`（不覆蓋、保留最新 3 份）；
 * 暫時性讀取錯誤（EBUSY／EACCES…）不動檔案；較新版本的檔案原樣保留。
 */
export class ProjectStore {
  private dir: string
  /** 最近一次讀寫失敗訊息（成功時清除）；供 UI 顯示。 */
  lastError: string | null = null
  lastErrorKind: ProjectErrorKind | null = null

  constructor(dir: string) {
    this.dir = dir
  }

  private setError(kind: ProjectErrorKind, message: string): void {
    this.lastErrorKind = kind
    this.lastError = message
  }

  private clearError(): void {
    this.lastErrorKind = null
    this.lastError = null
  }

  private filePath(id: string): string {
    if (!isValidId(id)) {
      throw new Error(tr('無效的專案 id：{id}', { id: String(id) }))
    }
    return path.join(this.dir, `${id}.json`)
  }

  /** 同步寫入（關閉視窗的 flushSync 路徑也走這裡）。 */
  saveSync(p: StoredProject): void {
    let tmp = ''
    try {
      if (!p || typeof p !== 'object') throw new Error(tr('專案資料無效'))
      const file = this.filePath(p.id)
      const shape = projectShapeError(p)
      if (shape) throw new Error(tr('專案資料無效：{message}', { message: shape.message }))
      tmp = `${file}.tmp`
      fs.mkdirSync(this.dir, { recursive: true })
      const fd = fs.openSync(tmp, 'w')
      try {
        fs.writeSync(fd, JSON.stringify(p, null, 2), null, 'utf-8')
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      fs.renameSync(tmp, file)
      this.clearError()
    } catch (err) {
      this.setError('save', tr('儲存專案失敗：{message}', { message: (err as Error).message }))
      if (tmp) {
        try {
          fs.unlinkSync(tmp)
        } catch {}
      }
      throw err
    }
  }

  async save(p: StoredProject): Promise<void> {
    this.saveSync(p)
  }

  async load(id: string): Promise<StoredProject | null> {
    const file = this.filePath(id)
    let raw: string
    try {
      raw = fs.readFileSync(file, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      // 暫時性錯誤（檔案被占用／權限）：不改名、不刪除，下次再試
      this.setError('transient', tr('暫時無法讀取專案檔（{id}.json）：{message}', { id, message: (err as Error).message }))
      return null
    }
    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch (err) {
      this.quarantine(id, file, (err as Error).message)
      return null
    }
    const shape = projectShapeError(data)
    if (shape?.kind === 'unsupported') {
      this.setError('unsupported', tr('專案檔 {id}.json：{message}', { id, message: shape.message }))
      return null
    }
    if (shape) {
      this.quarantine(id, file, shape.message)
      return null
    }
    return { ...(data as StoredProject), id }
  }

  /** 損毀檔案改名為不重複的備份名，並只保留最新 MAX_BACKUPS 份。 */
  private quarantine(id: string, file: string, reason: string): void {
    this.setError('corrupt', tr('專案檔損毀（{id}.json）：{reason}', { id, reason }))
    try {
      let ts = Date.now()
      let dest = path.join(this.dir, `${id}.bak.${ts}.json`)
      while (fs.existsSync(dest)) {
        ts += 1
        dest = path.join(this.dir, `${id}.bak.${ts}.json`)
      }
      fs.renameSync(file, dest)
      this.pruneBackups(id)
    } catch {}
  }

  private pruneBackups(id: string): void {
    const prefix = `${id}.bak.`
    const re = /^(\d+)\.json$/
    const baks = fs
      .readdirSync(this.dir)
      .filter((n) => n.startsWith(prefix))
      .map((n) => ({ n, ts: Number(re.exec(n.slice(prefix.length))?.[1]) }))
      .filter((x) => Number.isFinite(x.ts))
      .sort((a, b) => b.ts - a.ts)
    for (const old of baks.slice(MAX_BACKUPS)) {
      try {
        fs.unlinkSync(path.join(this.dir, old.n))
      } catch {}
    }
  }

  async list(): Promise<ProjectListEntry[]> {
    this.clearError()
    let names: string[]
    try {
      names = fs.readdirSync(this.dir)
    } catch {
      return []
    }
    const entries: ProjectListEntry[] = []
    for (const name of names) {
      if (!name.endsWith('.json') || name.includes('.bak.')) continue
      const id = name.slice(0, -'.json'.length)
      if (!isValidId(id)) continue
      const file = path.join(this.dir, name)
      try {
        const stat = fs.statSync(file)
        const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
        const shape = projectShapeError(data)
        if (shape) {
          this.setError(shape.kind === 'unsupported' ? 'unsupported' : 'corrupt', tr('專案檔 {name}：{message}', { name, message: shape.message }))
          continue
        }
        entries.push({ id, name: data.name, updatedAt: stat.mtimeMs, items: data.items.length })
      } catch (err) {
        // 損毀檔案留給 load() 備份；清單只記錄錯誤
        this.setError('corrupt', tr('專案檔損毀（{name}）：{message}', { name, message: (err as Error).message }))
      }
    }
    entries.sort((a, b) => b.updatedAt - a.updatedAt)
    return entries
  }

  async remove(id: string): Promise<void> {
    try {
      fs.unlinkSync(this.filePath(id))
    } catch {
      // 不存在視為已刪除
    }
  }
}
