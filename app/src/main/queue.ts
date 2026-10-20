import { EventEmitter } from 'events'
import { EngineClient } from './engine'
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
}

export class AnalysisQueue extends EventEmitter {
  private engine: EngineClient
  private library: Library
  private opts: AnalysisQueueOptions
  private queue: string[] = []
  private current: CurrentRun | null = null

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

  enqueue(videoPath: string): void {
    const norm = normalizePath(videoPath)
    const running = this.current && !this.current.cancelled && normalizePath(this.current.path) === norm
    if (!running && !this.queue.some((p) => normalizePath(p) === norm)) {
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
      this.library.update(videoPath, { status: 'pending', progress: 0, analyzingSince: undefined })
      this.emit('update')
    }
  }

  private async _processNext(): Promise<void> {
    if (this.current || this.queue.length === 0) {
      return
    }

    const videoPath = this.queue.shift()!
    const run: CurrentRun = { path: videoPath, reqId: null, cancelled: false }
    this.current = run

    this.library.update(videoPath, {
      status: 'analyzing',
      progress: 0,
      error: undefined,
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
          beside: extra.beside
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

      // Rewrite the cache only after success (cancellation/failure leaves the old cache untouched).
      try {
        preserveClipsAfterReanalysis(prior, doc, videoPath, this.opts.cacheDir, extra.beside)
      } catch (err) {
        console.error('[Queue] failed to preserve clips after re-analysis:', err)
      }

      const duration = doc.video?.duration || 0
      const thumb = await this._generateThumbnail(videoPath, duration).catch(() => undefined)

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
        const msg = err instanceof Error ? err.message : String(err)
        this.library.update(videoPath, { status: 'error', error: msg, analyzingSince: undefined })
      }
    } finally {
      this.current = null
      this.emit('update')
      // Process next in queue
      void this._processNext()
    }
  }

  private _generateThumbnail(videoPath: string, duration: number): Promise<string | undefined> {
    return generateThumbnail(videoPath, duration)
  }
}
