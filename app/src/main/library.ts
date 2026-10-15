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
}

const SUPPORTED_EXTS = new Set(['.mp4', '.mkv', '.mov', '.webm'])

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

  load(): void {
    try {
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, 'utf-8')
        this.entries = JSON.parse(raw)
      }
    } catch {
      this.entries = []
    }
  }

  save(): void {
    try {
      const dir = path.dirname(this.file)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      fs.writeFileSync(this.file, JSON.stringify(this.entries, null, 2), 'utf-8')
    } catch (err) {
      console.error('Failed to save library:', err)
    }
  }

  getEntries(): LibraryEntry[] {
    return [...this.entries]
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
      this.save()
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

export function watchFolder(dir: string, onAdd: (paths: string[]) => void): FSWatcher {
  const watcher = chokidar.watch(dir, {
    ignored: /(^|[\/\\])\../, // ignore dotfiles
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 5000,
      pollInterval: 500
    }
  })

  watcher.on('add', (filePath) => {
    onAdd([filePath])
  })

  return watcher
}
