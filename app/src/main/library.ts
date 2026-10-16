import fs from 'fs'
import path from 'path'
import chokidar, { FSWatcher } from 'chokidar'
import { EventType } from '../shared/types'

export type LibraryStatus = 'pending' | 'analyzing' | 'done' | 'error'

export interface LibraryEntry {
  path: string
  addedAt: number
  favorite: boolean
  status: LibraryStatus
  progress: number
  error?: string
  counts?: { knock: number; assist: number }
  durationSec?: number
  thumb?: string
  /** 預設參數下可產生的精華段數（Task 11 惰性寫入，供卡片徽章與「有精華」篩選） */
  hl?: number
  /** 影片編碼（分析完成後寫入，供卡片代理檔建議徽章） */
  codec?: string
  /** main 記錄的分析開始時間（epoch ms；僅分析中有值，供 ETA = now - analyzingSince） */
  analyzingSince?: number
}

export const SUPPORTED_EXTS = new Set(['.mp4', '.mkv', '.mov', '.webm'])

export function normalizePath(p: string): string {
  return path.resolve(p).toLowerCase().replace(/\\/g, '/')
}

export class Library {
  private file: string
  private entries: LibraryEntry[] = []

  constructor(file: string) {
    this.file = file
    this.load()
  }

  /** 讀到損毀檔時，原檔被改名成的備份路徑（供提示使用者）；正常為 null。 */
  corruptBackup: string | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private dirty = false

  load(): void {
    if (!fs.existsSync(this.file)) return
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, 'utf-8'))
      if (!Array.isArray(parsed)) throw new Error('library.json 不是陣列')
      this.entries = parsed as LibraryEntry[]
    } catch (err) {
      // 損毀：先把原檔改名備份，之後的 save() 才不會用空陣列蓋掉它
      this.entries = []
      const bak = path.join(path.dirname(this.file), `library.bak.${Date.now()}.json`)
      try {
        fs.renameSync(this.file, bak)
        this.corruptBackup = bak
      } catch (e) {
        console.error('Failed to back up corrupt library:', e)
      }
      console.error('Library file is corrupt, moved aside:', err)
    }
  }

  /** 原子寫入（tmp + fsync + rename）；失敗時原檔不變。 */
  save(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.dirty = false
    const tmp = `${this.file}.tmp`
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const fd = fs.openSync(tmp, 'w')
      try {
        fs.writeFileSync(fd, JSON.stringify(this.entries, null, 2), 'utf-8')
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      fs.renameSync(tmp, this.file)
    } catch (err) {
      console.error('Failed to save library:', err)
      try {
        fs.rmSync(tmp, { force: true })
      } catch {}
    }
  }

  /** 進度更新只動記憶體，最多每 2 秒落盤一次（2 小時分析不會每秒寫 4 次）。 */
  private scheduleSave(): void {
    this.dirty = true
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      if (this.dirty) this.save()
    }, 2000)
    this.saveTimer.unref?.()
  }

  /** 立即寫入尚未落盤的變更（App 結束前呼叫）。 */
  flush(): void {
    if (this.dirty) this.save()
  }

  getEntries(): LibraryEntry[] {
    return [...this.entries]
  }

  /** 以路徑取得單一條目（不複製整個陣列） */
  get(videoPath: string): LibraryEntry | undefined {
    const norm = normalizePath(videoPath)
    return this.entries.find((e) => normalizePath(e.path) === norm)
  }

  /**
   * 啟動時呼叫：上次執行中斷（崩潰／強制關閉）遺留的 'analyzing' 條目沒有任何佇列在處理，
   * 重設為閒置（pending／0／無 analyzingSince）；回傳重設筆數。
   */
  resetStaleAnalyzing(): number {
    let n = 0
    for (const e of this.entries) {
      if (e.status === 'analyzing') {
        e.status = 'pending'
        e.progress = 0
        delete e.analyzingSince
        n++
      }
    }
    if (n > 0) {
      this.save()
    }
    return n
  }

  add(paths: string[]): LibraryEntry[] {
    const existing = new Set(this.entries.map((e) => normalizePath(e.path)))
    const added: LibraryEntry[] = []

    for (const p of paths) {
      const ext = path.extname(p).toLowerCase()
      if (!SUPPORTED_EXTS.has(ext)) {
        continue
      }
      const norm = normalizePath(p)
      if (existing.has(norm)) {
        continue
      }
      existing.add(norm)
      const entry: LibraryEntry = {
        path: p,
        addedAt: Date.now(),
        favorite: false,
        status: 'pending',
        progress: 0
      }
      this.entries.push(entry)
      added.push(entry)
    }

    if (added.length > 0) {
      this.save()
    }
    return added
  }

  remove(videoPath: string): boolean {
    const norm = normalizePath(videoPath)
    const initialLen = this.entries.length
    this.entries = this.entries.filter((e) => normalizePath(e.path) !== norm)
    if (this.entries.length !== initialLen) {
      this.save()
      return true
    }
    return false
  }

  toggleFavorite(videoPath: string): boolean {
    const norm = normalizePath(videoPath)
    const entry = this.entries.find((e) => normalizePath(e.path) === norm)
    if (entry) {
      entry.favorite = !entry.favorite
      this.save()
      return entry.favorite
    }
    return false
  }

  update(videoPath: string, patch: Partial<LibraryEntry>): void {
    const norm = normalizePath(videoPath)
    const entry = this.entries.find((e) => normalizePath(e.path) === norm)
    if (entry) {
      Object.assign(entry, patch)
      const keys = Object.keys(patch)
      if (keys.length > 0 && keys.every((k) => k === 'progress')) this.scheduleSave()
      else this.save()
    }
  }

  search(q: string, filter?: { favorite?: boolean; hasEvents?: EventType[] }): LibraryEntry[] {
    const needle = q.trim().toLowerCase()
    return this.entries.filter((e) => {
      if (needle) {
        const base = path.basename(e.path).toLowerCase()
        if (!base.includes(needle)) {
          return false
        }
      }
      if (filter?.favorite && !e.favorite) {
        return false
      }
      if (filter?.hasEvents && filter.hasEvents.length > 0) {
        const counts = e.counts || { knock: 0, assist: 0 }
        const hasKnock = filter.hasEvents.includes('knock') && counts.knock > 0
        const hasAssist =
          (filter.hasEvents.includes('assist_knock') || filter.hasEvents.includes('assist_elim')) &&
          counts.assist > 0
        if (!hasKnock && !hasAssist) {
          return false
        }
      }
      return true
    })
  }
}

export interface WatchFolderOptions {
  /** 檔案大小需穩定的毫秒數（預設 5000，維持既有行為） */
  stabilityMs?: number
  /** 大小檢查的輪詢間隔毫秒數（預設 500） */
  pollMs?: number
}

export function watchFolder(dir: string, onAdd: (paths: string[]) => void, opts: WatchFolderOptions = {}): FSWatcher {
  const watcher = chokidar.watch(dir, {
    ignored: /(^|[\/\\])\../, // ignore dotfiles
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: opts.stabilityMs ?? 5000,
      pollInterval: opts.pollMs ?? 500
    }
  })

  watcher.on('add', (filePath) => {
    onAdd([filePath])
  })

  return watcher
}
