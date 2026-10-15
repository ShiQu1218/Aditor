import { EventEmitter } from 'events'
import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { EngineClient } from './engine'
import { Library, normalizePath } from './library'
import { CacheDoc, isCounted } from '../shared/types'
import { proxyDir } from '../shared/paths'

export interface AnalysisQueueOptions {
  profileDir: string
  cacheDir: string
}

export class AnalysisQueue extends EventEmitter {
  private engine: EngineClient
  private library: Library
  private opts: AnalysisQueueOptions
  private queue: string[] = []
  private currentPath: string | null = null
  private currentReqId: string | null = null
  private isProcessing = false

  constructor(engine: EngineClient, library: Library, opts: AnalysisQueueOptions) {
    super()
    this.engine = engine
    this.library = library
    this.opts = opts
  }

  enqueue(videoPath: string): void {
    const norm = normalizePath(videoPath)
    if (!this.queue.some((p) => normalizePath(p) === norm) && this.currentPath !== videoPath) {
      this.queue.push(videoPath)
      this.library.update(videoPath, { status: 'pending', progress: 0 })
      this.emit('update')
      this._processNext()
    }
  }

  cancel(videoPath: string): void {
    const norm = normalizePath(videoPath)
    if (this.currentPath && normalizePath(this.currentPath) === norm) {
      if (this.currentReqId) {
        this.engine.cancel(this.currentReqId)
      }
      this.library.update(videoPath, { status: 'pending', progress: 0 })
      this.currentPath = null
      this.currentReqId = null
      this.emit('update')
      this._processNext()
      return
    }

    const idx = this.queue.findIndex((p) => normalizePath(p) === norm)
    if (idx !== -1) {
      this.queue.splice(idx, 1)
      this.library.update(videoPath, { status: 'pending', progress: 0 })
      this.emit('update')
    }
  }

  private async _processNext(): Promise<void> {
    if (this.isProcessing || this.currentPath || this.queue.length === 0) {
      return
    }

    const videoPath = this.queue.shift()!
    this.currentPath = videoPath
    this.isProcessing = true

    this.library.update(videoPath, { status: 'analyzing', progress: 0, error: undefined })
    this.emit('update')

    try {
      const req = this.engine.request<CacheDoc>(
        'analyze',
        {
          path: videoPath,
          profile_dir: this.opts.profileDir,
          cache_dir: this.opts.cacheDir
        },
        (progress) => {
          const ratio = progress.duration > 0 ? progress.t / progress.duration : 0
          this.library.update(videoPath, { progress: Math.min(1, Math.max(0, ratio)) })
          this.emit('update')
        }
      )

      this.currentReqId = req.id
      const doc = await req.promise

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
        counts: { knock, assist },
        durationSec: duration,
        thumb,
        codec: doc.video?.codec,
        // 重新分析完成：引擎文件只含手動片段，舊的 N 精華作廢，交給惰性計算重算
        hl: undefined
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.library.update(videoPath, { status: 'error', error: msg })
    } finally {
      this.currentPath = null
      this.currentReqId = null
      this.isProcessing = false
      this.emit('update')
      // Process next in queue
      this._processNext()
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
