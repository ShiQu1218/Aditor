import { EventEmitter } from 'events'
import { EngineClient, EngineError } from './engine'
import { tr } from '../shared/locale'
import { Library, normalizePath } from './library'
import { CacheDoc, countEvents } from '../shared/types'
import { gameOf } from '../shared/games'
import type { QueuePayload, QueueSnapshot } from '../shared/queueState'
import { analyzeSettingArgs, AnalyzeSettings } from './settings-derived'
import { capturePriorCache, preserveClipsAfterReanalysis } from './reanalysis'
import { generateThumbnail } from './thumbnail'

export interface AnalysisQueueOptions {
  profileDir: string
  cacheDir: string
  /** Read before each analysis (setting changes take effect without a restart): decode → hwaccel, cacheLocation → beside. */
  getSettings?: () => AnalyzeSettings | undefined
}

interface CurrentRun {
  path: string
  reqId: string | null
  /** Cancelled by the user: report idle externally, but do not start the next item until the engine actually stops. */
  cancelled: boolean
  done: Promise<void>
}

export class AnalysisQueue extends EventEmitter {
  private engine: EngineClient
  private library: Library
  private opts: AnalysisQueueOptions
  private queue: string[] = []
  private current: CurrentRun | null = null
  private removing = new Set<string>()
  /** Normalized paths the user explicitly asked to reanalyze; their run bypasses the engine cache. */
  private forced = new Set<string>()

  constructor(engine: EngineClient, library: Library, opts: AnalysisQueueOptions) {
    super()
    this.engine = engine
    this.library = library
    this.opts = opts
  }

  /**
   * Actual queue state: the video being analyzed and the videos waiting in the queue.
   * Note that Library `status === 'pending'` means only "not yet analyzed," not "queued"
   * (autoAnalyze off, manual imports, and cancelled items are pending but not queued).
   */
  snapshot(): QueueSnapshot {
    return {
      analyzing: this.current && !this.current.cancelled ? this.current.path : null,
      queued: [...this.queue]
    }
  }

  /** `library:updated`/`queue:getState` payload: queue snapshot plus progress and start time for the item being analyzed. */
  payload(): QueuePayload {
    const queue = this.snapshot()
    const entry = queue.analyzing ? this.library.get(queue.analyzing) : undefined
    return {
      queue,
      current:
        queue.analyzing && entry
          ? { path: queue.analyzing, progress: entry.progress ?? 0, analyzingSince: entry.analyzingSince ?? null }
          : null
    }
  }

  enqueue(videoPath: string, force = false): void {
    const norm = normalizePath(videoPath)
    if (this.removing.has(norm)) return
    // A path that is already running cannot be queued again, so keeping its force token would affect a later plain enqueue.
    const running = this.current && !this.current.cancelled && normalizePath(this.current.path) === norm
    if (running) return
    // Upgrade an already queued plain run to forced, but only add a token when the item is actually queued.
    if (force) this.forced.add(norm)
    if (!this.queue.some((p) => normalizePath(p) === norm)) {
      this.queue.push(videoPath)
      this.library.update(videoPath, { status: 'pending', progress: 0 })
      this.emit('update')
      void this._processNext()
    }
  }

  cancel(videoPath: string): void {
    const norm = normalizePath(videoPath)
    if (this.current && !this.current.cancelled && normalizePath(this.current.path) === norm) {
      this.current.cancelled = true
      this.forced.delete(norm)
      if (this.current.reqId) {
        this.engine.cancel(this.current.reqId)
      }
      // Show as idle immediately; _run cleanup must not change it to error after the engine stops.
      this.library.update(videoPath, { status: 'pending', progress: 0, analyzingSince: undefined })
      this.emit('update')
      return
    }

    const idx = this.queue.findIndex((p) => normalizePath(p) === norm)
    if (idx !== -1) {
      this.queue.splice(idx, 1)
      this.forced.delete(norm)
      this.library.update(videoPath, { status: 'pending', progress: 0, analyzingSince: undefined })
      this.emit('update')
    }
  }

  /** Keep sources idle until synchronous removal finishes, including an in-flight thumbnail. */
  async withStoppedAnalysis<T>(paths: string[], remove: () => T): Promise<T> {
    const norms = new Set(paths.map(normalizePath))
    if ([...norms].some((norm) => this.removing.has(norm))) throw new Error('Removal already in progress')
    for (const norm of norms) this.removing.add(norm)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const run = this.current
      for (const videoPath of paths) this.cancel(videoPath)
      this.queue = this.queue.filter((p) => !norms.has(normalizePath(p)))
      for (const norm of norms) this.forced.delete(norm)
      if (run && norms.has(normalizePath(run.path))) {
        await Promise.race([
          run.done,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Analysis did not stop in time; source file was not removed')), 10_000)
          })
        ])
      }
      return remove()
    } finally {
      clearTimeout(timer)
      for (const norm of norms) this.removing.delete(norm)
    }
  }

  private async _processNext(): Promise<void> {
    if (this.current || this.queue.length === 0) {
      return
    }

    const videoPath = this.queue.shift()!
    const force = this.forced.delete(normalizePath(videoPath))
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    const run: CurrentRun = { path: videoPath, reqId: null, cancelled: false, done }
    this.current = run

    this.library.update(videoPath, {
      status: 'analyzing',
      progress: 0,
      error: undefined,
      errorCode: undefined,
      analyzingSince: Date.now()
    })
    this.emit('update')

    try {
      // Read existing cached clips before reanalysis (the engine overwrites the cache and keeps manual clips only).
      const settings = this.opts.getSettings?.()
      const extra = analyzeSettingArgs(settings)
      const prior = capturePriorCache(videoPath, this.opts.cacheDir, extra.beside)
      const req = this.engine.request<CacheDoc>(
        'analyze',
        {
          path: videoPath,
          profile_dir: this.opts.profileDir,
          cache_dir: this.opts.cacheDir,
          hwaccel: extra.hwaccel,
          beside: extra.beside,
          // A game the user chose, or one recognised before; absent means the engine recognises it.
          game: this.library.get(videoPath)?.game,
          ...(force ? { force: true } : {})
        },
        (progress) => {
          if (run.cancelled) {
            return
          }
          const ratio = progress.duration > 0 ? progress.t / progress.duration : 0
          this.library.update(videoPath, { progress: Math.min(1, Math.max(0, ratio)) })
          this.emit('update')
        }
      )

      run.reqId = req.id
      if (run.cancelled) {
        this.engine.cancel(req.id)
      }
      const doc = await req.promise
      if (run.cancelled) return

      // Rewrite the cache only after success (cancellation/failure leaves the old cache untouched).
      try {
        preserveClipsAfterReanalysis(prior, doc, videoPath, this.opts.cacheDir, extra.beside)
      } catch (err) {
        console.error('[Queue] failed to preserve clips after re-analysis:', err)
      }

      const duration = doc.video?.duration || 0
      const thumb = await this._generateThumbnail(videoPath, duration).catch(() => undefined)
      if (run.cancelled) return

      this.library.update(videoPath, {
        status: 'done',
        progress: 1,
        analyzingSince: undefined,
        counts: countEvents(doc.events || []),
        game: gameOf(doc.game),
        durationSec: duration,
        thumb,
        codec: doc.video?.codec,
        // Reanalysis completed: invalidate the old N highlights count and let lazy computation recalculate it.
        hl: undefined
      })
    } catch (err) {
      if (run.cancelled) {
        // User cancelled: keep idle (already updated by cancel()), not an error.
        this.library.update(videoPath, { status: 'pending', progress: 0, error: undefined, analyzingSince: undefined })
      } else {
        if (err instanceof EngineError && err.code === 'unknown_game') {
          this.library.update(videoPath, { status: 'error', errorCode: 'unknown_game', analyzingSince: undefined,
            error: tr('認不出這支影片是哪個遊戲，請在卡片上選擇 Apex 或 Valorant。') })
        } else {
          const msg = err instanceof Error ? err.message : String(err)
          this.library.update(videoPath, { status: 'error', error: msg, analyzingSince: undefined })
        }
      }
    } finally {
      this.current = null
      finish()
      this.emit('update')
      // Process next in queue
      void this._processNext()
    }
  }

  private _generateThumbnail(videoPath: string, duration: number): Promise<string | undefined> {
    return generateThumbnail(videoPath, duration)
  }
}
