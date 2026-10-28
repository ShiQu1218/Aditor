import fs from 'fs'
import path from 'path'
import chokidar, { FSWatcher } from 'chokidar'
import { EventType, type EventCounts } from '../shared/types'
import type { GameId } from '../shared/games'

export type LibraryStatus = 'pending' | 'analyzing' | 'done' | 'error'

export interface LibraryEntry {
  path: string
  /** Only recordings added by the recording pipeline own their source file. Missing means legacy/unknown. */
  source?: 'recording' | 'external'
  addedAt: number
  favorite: boolean
  status: LibraryStatus
  progress: number
  error?: string
  /** Machine-readable failure reason: unknown_game means the user has to choose the game (sets `game`). */
  errorCode?: 'unknown_game'
  counts?: EventCounts
  /** Absent for entries analyzed before multi-game support (Apex). */
  game?: GameId
  durationSec?: number
  thumb?: string
  /** Number of highlight clips available with default parameters (Task 11 lazy write, used by card badges and the "has highlights" filter). */
  hl?: number
  /** Video codec (written after analysis, used by the card's proxy suggestion badge). */
  codec?: string
  /** Analysis start time recorded by main (epoch ms; set only while analyzing, used for ETA = now - analyzingSince). */
  analyzingSince?: number
}

export interface RemoveOptions {
  /**
   * Also delete the source file of entries that do not own it (imported or legacy entries).
   * Recordings always delete their source file, regardless of this flag.
   */
  deleteSource?: boolean
}

export const SUPPORTED_EXTS = new Set(['.mp4', '.mkv', '.mov', '.webm'])

export function normalizePath(p: string): string {
  return path.resolve(p).toLowerCase().replace(/\\/g, '/')
}

export class Library {
  private file: string
  private entries: LibraryEntry[] = []

  constructor(file: string, private beforeSourceRemoval?: (videoPath: string) => void) {
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
      // One malformed entry would crash later startup code; treat it as corruption so the file is backed up.
      if (!parsed.every((e) => e && typeof e === 'object' && typeof e.path === 'string' && typeof e.status === 'string')) {
        throw new Error('library.json has an invalid entry')
      }
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
  save(): boolean {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.dirty = true
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
      this.dirty = false
      return true
    } catch (err) {
      console.error('Failed to save library:', err)
      try {
        fs.rmSync(tmp, { force: true })
      } catch {}
      return false
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
  flush(): boolean {
    return !this.dirty || this.save()
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

  add(paths: string[], source: 'recording' | 'external' = 'external', game?: GameId): LibraryEntry[] {
    const existing = new Set(this.entries.map((e) => normalizePath(e.path)))
    const added: LibraryEntry[] = []
    let changed = false

    for (const p of paths) {
      const ext = path.extname(p).toLowerCase()
      if (!SUPPORTED_EXTS.has(ext)) {
        continue
      }
      const norm = normalizePath(p)
      if (existing.has(norm)) {
        // A folder watcher may have imported the recording before finalization finishes.
        const entry = this.get(p)!
        if (source === 'recording' && entry.source !== 'recording') {
          entry.source = source
          changed = true
        }
        if (game && !entry.game) {
          entry.game = game
          changed = true
        }
        continue
      }
      existing.add(norm)
      const entry: LibraryEntry = {
        path: p,
        source,
        addedAt: Date.now(),
        favorite: false,
        status: 'pending',
        progress: 0,
        ...(game ? { game } : {})
      }
      this.entries.push(entry)
      added.push(entry)
    }

    if (added.length > 0 || changed || this.dirty) {
      this.save()
    }
    return added
  }

  /**
   * Remove one entry. The source file is unlinked for recordings (they own it) and for every other entry only when
   * `opts.deleteSource` is true. A missing file is tolerated; any other failure keeps the entry (the error is thrown).
   */
  remove(videoPath: string, opts: RemoveOptions = {}): boolean {
    const entry = this.get(videoPath)
    if (!entry) return false
    if (entry.source === 'recording' || opts.deleteSource === true) {
      this.beforeSourceRemoval?.(entry.path)
      try {
        fs.unlinkSync(entry.path)
      } catch (err) {
        // Already-missing files can still be removed from the library; other failures retain the entry.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
    }
    const norm = normalizePath(videoPath)
    const initialLen = this.entries.length
    this.entries = this.entries.filter((e) => normalizePath(e.path) !== norm)
    if (this.entries.length !== initialLen) {
      this.save()
      return true
    }
    return false
  }

  /**
   * Remove several entries with the same per-entry rules as remove(): recording sources are unlinked (ENOENT tolerated),
   * and other sources are unlinked only when `opts.deleteSource` is true. A path whose source file cannot be deleted
   * stays in the library and is reported as failed. Persists once.
   */
  removeMany(paths: string[], opts: RemoveOptions = {}): { removed: string[]; failed: string[] } {
    const removed: string[] = []
    const failed: string[] = []
    const removedNorms = new Set<string>()
    for (const videoPath of paths) {
      const entry = this.get(videoPath)
      if (!entry) continue // Already gone (e.g. removed elsewhere): nothing to remove, not a failure.
      const norm = normalizePath(entry.path)
      if (removedNorms.has(norm)) continue // Duplicate path in the same request.
      if (entry.source === 'recording' || opts.deleteSource === true) {
        try { this.beforeSourceRemoval?.(entry.path) }
        catch { failed.push(entry.path); continue }
        try {
          fs.unlinkSync(entry.path)
        } catch (err) {
          // Already-missing files can still be removed from the library; other failures keep the entry.
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            failed.push(entry.path)
            continue
          }
        }
      }
      removedNorms.add(norm)
      removed.push(entry.path)
    }
    if (removedNorms.size > 0) {
      this.entries = this.entries.filter((e) => !removedNorms.has(normalizePath(e.path)))
      this.save()
    }
    return { removed, failed }
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
  /** Release probe override for tests; false means busy, ENOENT means removed. */
  isFileReleased?: (filePath: string) => Promise<boolean>
}

export const WATCH_RELEASE_TIMEOUT_MS = 10 * 60 * 1000

async function isFileReleased(filePath: string): Promise<boolean> {
  try {
    // Windows copies preallocate the final size before releasing the destination handle.
    const handle = await fs.promises.open(filePath, 'r+').catch(async (err: NodeJS.ErrnoException) => {
      if (!['EPERM', 'EACCES'].includes(err.code ?? '')) throw err
      // Windows copy writers also deny reads (engine: Permission denied); writers allowing reads report EBUSY on 'r+'.
      return fs.promises.open(filePath, 'r')
    })
    await handle.close()
    return true
  } catch (err) {
    if (['EBUSY', 'EPERM', 'EACCES'].includes((err as NodeJS.ErrnoException).code ?? '')) return false
    throw err
  }
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

  const probe = opts.isFileReleased ?? (process.platform === 'win32' ? isFileReleased : undefined)
  const pending = new Map<string, ReturnType<typeof setTimeout> | undefined>()
  let closed = false
  const close = watcher.close.bind(watcher)
  watcher.close = () => {
    closed = true
    for (const timer of pending.values()) clearTimeout(timer)
    pending.clear()
    return close()
  }

  watcher.on('add', (filePath) => {
    if (closed || pending.has(filePath)) return
    if (!probe) {
      onAdd([filePath])
      return
    }
    pending.set(filePath, undefined)
    const deadline = Date.now() + WATCH_RELEASE_TIMEOUT_MS
    const check = async (): Promise<void> => {
      if (closed) return
      try {
        const released = await probe(filePath)
        if (closed) return
        if (released) {
          pending.delete(filePath)
          onAdd([filePath])
        } else if (Date.now() >= deadline) {
          pending.delete(filePath)
          console.warn(`[Watch] Timed out waiting for file release: ${filePath}`)
        } else {
          pending.set(filePath, setTimeout(() => void check(), Math.min(opts.stabilityMs ?? 5000, deadline - Date.now())))
        }
      } catch (err) {
        pending.delete(filePath)
        if (!closed && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn(`[Watch] Failed to check file release: ${filePath}`, err)
        }
      }
    }
    void check()
  })

  return watcher
}
