import { Project } from './project'

/** Add a file id to a project (`createProject` is unchanged; the Provider generates the id). */
export type ProjectWithId = Project & { id: string }

/** Generate a filename-safe id in the `p_<uuid>` format. */
export function newProjectId(): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '')
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
  return `p_${uuid}`
}

/** The subset of window.api needed for restoration (easy to inject in tests). */
export interface RestoreApi {
  /** Read settings; callers can convert failures to null. */
  getSettings: () => Promise<{ lastProjectId?: string | null } | null>
  /** Read a project by id; return null if the file is missing or corrupted. */
  loadProject: (id: string) => Promise<Project | null>
}

/**
 * Restore the last project using `settings.lastProjectId`.
 * Return null when settings cannot be read, no id is recorded, or the file is missing or corrupted (use a new project).
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
  /** Missing source paths, deduplicated and ordered by clip. */
  missing: string[]
}

export interface ValidateOptions {
  /** Maximum number of paths to check concurrently (defaults to 4). */
  concurrency?: number
  /** Timeout per path in ms (defaults to 3000); treat a timeout as missing so an offline drive cannot stall loading. */
  timeoutMs?: number
}

/** Treat timeouts as false; never throw. */
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
 * Check whether each project source exists through `exists` (main process `library:fileExists`).
 * Use limited concurrency (defaults to 4) and a per-path timeout (defaults to 3 seconds); treat errors (IPC failures) and timeouts as missing.
 * The Task 13 UI marks clips with missing sources.
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
 * Derive the set of clip ids with missing sources (not persisted to the project file).
 * Compare source paths case-insensitively after normalizing slashes; the UI uses this set to show warnings and disable previews.
 */
export function missingItemIds(project: Project, missing: readonly string[]): ReadonlySet<string> {
  const gone = new Set(missing.map(normSource))
  return new Set(project.items.filter((i) => gone.has(normSource(i.source))).map((i) => i.id))
}

/** Throttle gate: return false if less than minMs has passed since the last allowed call (used to recheck sources when the window regains focus). */
export function createRefreshGate(minMs: number, now: () => number = Date.now): () => boolean {
  let last = -Infinity
  return () => {
    const t = now()
    if (t - last < minMs) return false
    last = t
    return true
  }
}
