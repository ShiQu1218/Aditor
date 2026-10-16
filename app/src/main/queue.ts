import { EventEmitter } from 'events'
import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { EngineClient } from './engine'
import { Library, normalizePath } from './library'
import { CacheDoc, isCounted } from '../shared/types'
import { proxyDir } from '../shared/paths'
import type { QueuePayload, QueueSnapshot } from '../shared/queueState'
import { analyzeSettingArgs, AnalyzeSettings } from './settings-derived'
import { capturePriorCache, preserveClipsAfterReanalysis } from './reanalysis'

export interface AnalysisQueueOptions {
  profileDir: string
  cacheDir: string
  /** 每次分析前讀取（設定變更免重啟）：decode → hwaccel、cacheLocation → beside */
  getSettings?: () => AnalyzeSettings | undefined
}

interface CurrentRun {
  path: string
  reqId: string | null
  /** 使用者已取消：對外視為閒置，但引擎真正停下前不啟動下一支 */
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
   * 佇列的真實狀態：正在分析的影片與排隊中的影片。
   * 注意 Library 的 `status === 'pending'` 只代表「尚未分析」，不代表在佇列中
   * （autoAnalyze 關閉、手動匯入、取消後都是 pending 但沒有排隊）。
   */
  snapshot(): QueueSnapshot {
    return {
      analyzing: this.current && !this.current.cancelled ? this.current.path : null,
      queued: [...this.queue]
    }
  }

  /** `library:updated`／`queue:getState` 的內容：佇列快照＋正在分析項目的進度與開始時間。 */
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
      // 立刻可見為閒置；引擎停止後 _run 的收尾不會把它改成 error
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
      // 重新分析前先唯讀擷取既有快取的片段（引擎會覆寫快取且只保留手動片段）
      const extra = analyzeSettingArgs(this.opts.getSettings?.())
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

      // 只有成功完成才改寫快取（取消／失敗不碰舊快取）
      try {
        preserveClipsAfterReanalysis(prior, doc, videoPath, this.opts.cacheDir, extra.beside)
      } catch (err) {
        console.error('[Queue] failed to preserve clips after re-analysis:', err)
      }

      let knock = 0
      let assist = 0
      for (const ev of doc.events || []) {
        if (isCounted(ev)) {
          if (ev.type === 'knock') {
            knock++
          } else if (ev.type === 'assist_knock' || ev.type === 'assist_elim') {
            assist++
          }
        }
      }

      const duration = doc.video?.duration || 0
      const thumb = await this._generateThumbnail(videoPath, duration).catch(() => undefined)

      this.library.update(videoPath, {
        status: 'done',
        progress: 1,
        analyzingSince: undefined,
        counts: { knock, assist },
        durationSec: duration,
        thumb,
        codec: doc.video?.codec,
        // 重新分析完成：舊的 N 精華作廢，交給惰性計算重算
        hl: undefined
      })
    } catch (err) {
      if (run.cancelled) {
        // 使用者取消：維持閒置（cancel() 已更新），不是錯誤
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

  private async _generateThumbnail(videoPath: string, duration: number): Promise<string | undefined> {
    if (!fs.existsSync(videoPath)) {
      return undefined
    }
    const hash = crypto.createHash('sha1').update(normalizePath(videoPath)).digest('hex')
    const thumbsDir = path.join(proxyDir(), 'thumbs')
    if (!fs.existsSync(thumbsDir)) {
      fs.mkdirSync(thumbsDir, { recursive: true })
    }
    const outPath = path.join(thumbsDir, `${hash}.jpg`)
    if (fs.existsSync(outPath)) {
      return outPath
    }

    const t = Math.max(1, duration * 0.1)
    return new Promise((resolve) => {
      const ffmpeg = spawn(process.env.APEXHL_FFMPEG || 'ffmpeg', [
        '-v',
        'error',
        '-ss',
        t.toFixed(2),
        '-i',
        videoPath,
        '-vframes',
        '1',
        '-q:v',
        '3',
        '-y',
        outPath
      ])
      ffmpeg.on('close', (code) => {
        if (code === 0 && fs.existsSync(outPath)) {
          resolve(outPath)
        } else {
          resolve(undefined)
        }
      })
      ffmpeg.on('error', () => resolve(undefined))
    })
  }
}
