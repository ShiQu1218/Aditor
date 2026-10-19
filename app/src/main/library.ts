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
  /** Number of highlight clips available with default parameters (Task 11 lazy write, used by card badges and the "has highlights" filter). */
  hl?: number
  /** Video codec (written after analysis, used by the card's proxy suggestion badge). */
  codec?: string
  /** Analysis start time recorded by main (epoch ms; set only while analyzing, used for ETA = now - analyzingSince). */
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

  /** Path of the renamed backup when a corrupt file is found (for notifying the user); null otherwise. */
  corruptBackup: string | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private dirty = false

  load(): void {
    if (!fs.existsSync(this.file)) return
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, 'utf-8'))
      if (!Array.isArray(parsed)) throw new Error('library.json is not an array')
      this.entries = parsed as LibraryEntry[]
    } catch (err) {
      // Corrupt file: rename it as a backup first so a later save() does not overwrite it with an empty array.
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

  /** Atomic write (tmp + fsync + rename); the original file is unchanged on failure. */
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

  /** Progress updates change memory only and are persisted at most once every 2 seconds (a 2-hour analysis will not write 4 times per second). */
  private scheduleSave(): void {
    this.dirty = true
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      if (this.dirty) this.save()
    }, 2000)
    this.saveTimer.unref?.()
  }

  /** Immediately persist pending changes (called before the app exits). */
  flush(): void {
    if (this.dirty) this.save()
  }

  getEntries(): LibraryEntry[] {
    return [...this.entries]
  }

  /** Get a single entry by path (without copying the full array). */
  get(videoPath: string): LibraryEntry | undefined {
    const norm = normalizePath(videoPath)
    return this.entries.find((e) => normalizePath(e.path) === norm)
  }

  /**
   * Called at startup: entries left as 'analyzing' by a previous interrupted run (crash/forced close) are not in any queue,
   * so reset them to idle (pending/0/no analyzingSince) and return the number reset.
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
  /** Milliseconds the file size must remain stable (default 5000, preserving existing behavior). */
  stabilityMs?: number
  /** File-size polling interval in milliseconds (default 500). */
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
