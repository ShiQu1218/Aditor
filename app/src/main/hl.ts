import { mergeOnReanalyze, suggestionCount } from '../shared/clips'
import type { AutoClipParams, CacheDoc, Clip } from '../shared/types'

/** Minimal interface compatible with EngineClient.request (cmd/args → result). */
export type EngineRequest = (cmd: string, args: Record<string, unknown>) => Promise<unknown>

/**
 * Lazily compute the library's "N highlights" with default parameters: the number of pending suggestions (status === 'suggested').
 * - Use only an existing cache file; never call engine `analyze` (missing/incomplete cache → null, leaving hl undefined).
 * - If the document already has AI clips, count suggested clips directly (no engine call).
 * - If the document has no AI clips (manual clips only), count clips from autoclip with default parameters; Studio will add them as suggestions.
 * - After reanalysis with `app.suggestionsPending`, count the suggestions in the merge result Studio will produce (mergeOnReanalyze).
 * Return null on failure (without writing); on success return a number >= 0.
 */
export async function computeHlCount(
  request: EngineRequest,
  doc: CacheDoc | null,
  params: AutoClipParams
): Promise<number | null> {
  if (!doc || !Array.isArray(doc.events) || doc.analysis?.status !== 'done') return null
  const clips = Array.isArray(doc.clips) ? doc.clips : []
  const pending = Boolean(doc.app?.suggestionsPending)
  if (!pending && clips.some((c) => c.origin === 'ai')) return hlFromClips(clips)
  try {
    const res = (await request('autoclip', {
      events: doc.events,
      params,
      duration: doc.video?.duration ?? 0
    })) as { clips?: Clip[] } | null
    const fresh = Array.isArray(res?.clips) ? res.clips : []
    return pending ? suggestionCount(mergeOnReanalyze(clips, fresh)) : fresh.length
  } catch {
    return null
  }
}

/** Recompute library hl from clips: the current pending-suggestion count (legacy files without status are treated as added). */
export function hlFromClips(clips: Clip[] | undefined): number {
  return (clips ?? []).filter((c) => c.origin === 'ai' && (c.status ?? 'accepted') === 'suggested').length
}

/** hl value when Studio saves: do not decide while post-reanalysis suggestions are pending recomputation (undefined delegates to lazy computation). */
export function hlForSavedDoc(doc: { clips?: Clip[]; app?: { suggestionsPending?: boolean } }): number | undefined {
  return doc.app?.suggestionsPending ? undefined : hlFromClips(doc.clips)
}

export const HL_NEGATIVE_TTL_MS = 60_000

/**
 * Safeguards for computeHl:
 * - Negative cache: do not retry a video whose computation failed (null) for 60 seconds (avoids repeated engine calls while scrolling cards).
 * - Revision number: `bump` marks a newer authoritative hl write (Studio cache:save); if the revision has changed when an older computation
 *   commits through `commitIfCurrent`, discard it so stale results cannot overwrite the newer hl.
 */
export function createHlGuard(now: () => number = Date.now) {
  const revs = new Map<string, number>()
  const failedAt = new Map<string, number>()
  return {
    rev: (key: string): number => revs.get(key) ?? 0,
    bump(key: string): void {
      revs.set(key, (revs.get(key) ?? 0) + 1)
      failedAt.delete(key)
    },
    isNegative(key: string): boolean {
      const at = failedAt.get(key)
      if (at === undefined) return false
      if (now() - at < HL_NEGATIVE_TTL_MS) return true
      failedAt.delete(key)
      return false
    },
    markFailed(key: string): void {
      failedAt.set(key, now())
    },
    commitIfCurrent(key: string, startedRev: number, write: () => void): boolean {
      if ((revs.get(key) ?? 0) !== startedRev) return false
      write()
      return true
    }
  }
}

/** FIFO with concurrency 1; requests with the same key share a Promise while queued or running (deduplicated). */
export function createSerialQueue<T>(): {
  run: (key: string, task: () => Promise<T>) => Promise<T>
  size: () => number
} {
  const pending = new Map<string, Promise<T>>()
  let tail: Promise<unknown> = Promise.resolve()
  return {
    run(key, task) {
      const existing = pending.get(key)
      if (existing) return existing
      const p = tail.then(task)
      pending.set(key, p)
      const done = (): void => {
        pending.delete(key)
      }
      p.then(done, done)
      tail = p.catch(() => undefined)
      return p
    },
    size: () => pending.size
  }
}
