import fs from 'fs'
import path from 'path'
import { ProjectItem } from '../renderer/editor/project'

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

/**
 * `%APPDATA%\ApexHighlighter\projects\<id>.json` 的讀寫者。
 * 寫入走暫存檔＋rename（原子替換，失敗保留上一版）；
 * 讀取損毀檔案改名為 `<id>.bak.json` 並在 `lastError` 記錄。
 */
export class ProjectStore {
  private dir: string
  /** 最近一次讀寫失敗訊息（成功時清除）；供 UI 顯示。 */
  lastError: string | null = null

  constructor(dir: string) {
    this.dir = dir
  }

  private filePath(id: string): string {
    if (!ID_RE.test(id)) {
      throw new Error(`無效的專案 id：${id}`)
    }
    return path.join(this.dir, `${id}.json`)
  }

  async save(p: StoredProject): Promise<void> {
    const file = this.filePath(p.id)
    const tmp = `${file}.tmp`
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify(p, null, 2), 'utf-8')
      fs.renameSync(tmp, file)
      this.lastError = null
    } catch (err) {
      this.lastError = `儲存專案失敗：${(err as Error).message}`
      try {
        fs.unlinkSync(tmp)
      } catch {}
      throw err
    }
  }

  async load(id: string): Promise<StoredProject | null> {
    const file = this.filePath(id)
    if (!fs.existsSync(file)) return null
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
      if (!data || data.version !== 1 || typeof data.name !== 'string' || !Array.isArray(data.items)) {
        throw new Error('格式不符')
      }
      return { ...data, id } as StoredProject
    } catch (err) {
      this.lastError = `專案檔損毀（${id}.json）：${(err as Error).message}`
      try {
        fs.renameSync(file, path.join(this.dir, `${id}.bak.json`))
      } catch {}
      return null
    }
  }

  async list(): Promise<ProjectListEntry[]> {
    let names: string[]
    try {
      names = fs.readdirSync(this.dir)
    } catch {
      return []
    }
    const entries: ProjectListEntry[] = []
    for (const name of names) {
      if (!name.endsWith('.json') || name.endsWith('.bak.json')) continue
      const file = path.join(this.dir, name)
      try {
        const stat = fs.statSync(file)
        const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
        if (!data || data.version !== 1 || !Array.isArray(data.items)) continue
        entries.push({
          id: name.slice(0, -'.json'.length),
          name: typeof data.name === 'string' ? data.name : name,
          updatedAt: stat.mtimeMs,
          items: data.items.length
        })
      } catch {
        // 損毀檔案交由 load() 備份，清單先略過
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
