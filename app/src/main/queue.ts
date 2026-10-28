import { EventEmitter } from 'events'
import { EngineClient, EngineError } from './engine'
import { tr } from '../shared/locale'
import { Library, normalizePath } from './library'
import { CacheDoc, countEvents } from '../shared/types'
import { cacheFilePath, loadCacheDoc } from './cache-io'
import { gameOf } from '../shared/games'
import type { QueuePayload, QueueSnapshot } from '../shared/queueState'
import { analyzeSettingArgs, AnalyzeSettings } from './settings-derived'
import { capturePriorCache, preserveClipsAfterReanalysis } from './reanalysis'
import { generateThumbnail } from './thumbnail'

export interface AnalysisQueueOptions {
  profileDir: string
  cacheDir: string
  /** Block startup until the first successful game query. */
  gameRunning?: boolean
  /** Read before each analysis (setting changes take effect without a restart): decode → hwaccel, cacheLocation → beside. */
  getSettings?: () => AnalyzeSettings | undefined
}

interface CurrentRun {
  path: string
  reqId: string | null
  /** Interrupted: hide the active run, but wait for the engine to stop before starting another item. */
  cancelled: boolean
  engineFinished: boolean
  force: boolean
  done: Promise<void>
  cachePath?: string
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
  private gameRunning: boolean

  constructor(engine: EngineClient, library: Library, opts: AnalysisQueueOptions) {
    super()
    this.engine = engine
    this.library = library
    this.opts = opts
    this.gameRunning = opts.gameRunning ?? false
  }

  setGameRunning(running: boolean): void {
    if (this.gameRunning === running) return
    this.gameRunning = running
    const run = this.current
    // Once the engine finishes, preserve clips before another run can replace their backup.
    if (running && run && !run.cancelled && !run.engineFinished) {
      // Reuse engine cancellation, but retain the job and its explicit reanalysis intent.
      this.cancel(run.path)
      this.queue.unshift(run.path)
      if (run.force) this.forced.add(normalizePath(run.path))
    }
    this.emit('update')
    if (!running) void this._processNext()
  }

  /**
   * Actual queue state: the video being analyzed and the videos waiting in the queue.
   * Note that Library `status === 'pending'` means only "not yet analyzed," not "queued"
   * (autoAnalyze off, manual imports, and cancelled items are pending but not queued).
   */
  snapshot(): QueueSnapshot {
    return {
      analyzing: this.current && !this.current.cancelled ? this.current.path : null,
      queued: [...this.queue],
      ...(this.gameRunning ? { waitingForGame: true } : {})
    }
  }

  /** Includes a cancelled run until the engine acknowledges cancellation. */
  activeCachePath(videoPath: string): string | undefined {
    return this.current && normalizePath(this.current.path) === normalizePath(videoPath)
      ? this.current.cachePath : undefined
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
    if (this.gameRunning || this.current || this.queue.length === 0) {
      return
    }

    const videoPath = this.queue.shift()!
    const force = this.forced.delete(normalizePath(videoPath))
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    const run: CurrentRun = { path: videoPath, reqId: null, cancelled: false, engineFinished: false, force, done }
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
      run.cachePath = cacheFilePath(videoPath, this.opts.cacheDir, extra.beside)
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
      let doc = await req.promise
      run.engineFinished = true
      // Rewrite the cache only after success (cancellation/failure leaves the old cache untouched).
      const preserve = (): void => {
        try {
          if (preserveClipsAfterReanalysis(prior, doc, videoPath, this.opts.cacheDir, extra.beside, force)) {
            doc = (loadCacheDoc(doc.cache_path || run.cachePath!) as CacheDoc | null) ?? doc
          }
        } catch (err) {
          console.error('[Queue] failed to preserve clips after re-analysis:', err)
        }
      }
      if (run.cancelled) {
        // The engine finished before it saw the cancellation and already replaced the cache;
        // restore clips now, or the retry would back up the replaced cache and lose them.
        preserve()
        return
      }

      const duration = doc.video?.duration || 0
      const thumb = await this._generateThumbnail(videoPath, duration).catch(() => undefined)

      // After the thumbnail, so edits saved while it was generated are merged too;
      // a cancel during the thumbnail still needs it, as the engine already replaced the cache.
      preserve()
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
        // Interrupted runs remain pending, including jobs deferred until the game exits.
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
