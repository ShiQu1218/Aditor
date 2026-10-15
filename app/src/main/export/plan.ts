import path from 'path'
import { ProjectItem } from '../../renderer/editor/project'
import { estimateOutputBytes as estimateBytes } from '../../shared/exportEstimate'

export interface StreamProbe {
  vcodec: string
  width: number
  height: number
  fps: number
  pix_fmt: string
  acodec: string
  sample_rate: number
  channels: number
}

export interface FfmpegJob {
  args: string[]
  output: string
  tempFiles?: string[]
}

export class NoEncoderError extends Error {
  constructor(message = 'No video encoder available for precise export') {
    super(message)
    this.name = 'NoEncoderError'
  }
}

export function extraSecondsForCopy(start: number, keyframes: number[]): number {
  if (!keyframes || keyframes.length === 0) {
    return Math.round(start * 1000) / 1000
  }

  let priorKf = -1
  for (const kf of keyframes) {
    if (kf <= start) {
      if (kf > priorKf) {
        priorKf = kf
      }
    }
  }

  if (priorKf === -1) {
    return Math.round(start * 1000) / 1000
  }

  const extra = start - priorKf
  return Math.round(extra * 1000) / 1000
}

export function concatCompatible(probes: StreamProbe[]): { ok: boolean; reason?: string } {
  if (probes.length <= 1) {
    return { ok: true }
  }

  const first = probes[0]
  for (let i = 1; i < probes.length; i++) {
    const p = probes[i]
    if (p.vcodec !== first.vcodec) {
      return { ok: false, reason: `視訊編碼不同: ${first.vcodec} vs ${p.vcodec}` }
    }
    if (p.width !== first.width || p.height !== first.height) {
      return { ok: false, reason: `解析度不同: ${first.width}x${first.height} vs ${p.width}x${p.height}` }
    }
    if (Math.abs(p.fps - first.fps) > 0.5) {
      return { ok: false, reason: `幀率不同: ${first.fps} vs ${p.fps}` }
    }
    if (p.pix_fmt !== first.pix_fmt) {
      return { ok: false, reason: `像素格式不同: ${first.pix_fmt} vs ${p.pix_fmt}` }
    }
    if (p.acodec !== first.acodec) {
      return { ok: false, reason: `音訊編碼不同: ${first.acodec} vs ${p.acodec}` }
    }
    if (p.sample_rate !== first.sample_rate) {
      return { ok: false, reason: `音訊取樣率不同: ${first.sample_rate} vs ${p.sample_rate}` }
    }
    if (p.channels !== first.channels) {
      return { ok: false, reason: `音訊聲道數不同: ${first.channels} vs ${p.channels}` }
    }
  }

  return { ok: true }
}

export function escapeConcatPath(filePath: string): string {
  // Concat demuxer expects single quotes around path and single quotes escaped as '\'\''
  const normalized = filePath.replace(/\\/g, '/')
  const escaped = normalized.replace(/'/g, "'\\''")
  return `'${escaped}'`
}

export function estimateOutputBytes(
  items: ProjectItem[],
  quality: 'copy' | 'precise',
  _probes?: Map<string, StreamProbe>
): number {
  return estimateBytes({ items }, quality)
}

export function buildJobs(
  items: ProjectItem[],
  opts: {
    mode: 'separate' | 'concat'
    quality: 'copy' | 'precise'
    encoder?: string
    outDir: string
    baseName: string
  },
  probes: Map<string, StreamProbe>
): { jobs: FfmpegJob[]; notices: string[] } {
  const notices: string[] = []
  let effectiveQuality = opts.quality

  if (opts.mode === 'concat' && opts.quality === 'copy') {
    const probeList = items.map((it) => probes.get(it.source)).filter((p): p is StreamProbe => !!p)
    const check = concatCompatible(probeList)
    if (!check.ok) {
      effectiveQuality = 'precise'
      notices.push(`影片規格不相容（${check.reason}），已自動切換為精準轉碼模式`)
    }
  }

  if (effectiveQuality === 'precise' && !opts.encoder) {
    throw new NoEncoderError()
  }

  const jobs: FfmpegJob[] = []

  if (opts.mode === 'separate') {
    items.forEach((item, idx) => {
      const output = path.join(opts.outDir, `${opts.baseName}_${idx + 1}.mp4`)
      const dur = Math.max(0.1, item.end - item.start).toFixed(3)

      if (effectiveQuality === 'copy') {
        const args = [
          '-ss',
          item.start.toFixed(3),
          '-i',
          item.source,
          '-t',
          dur,
          '-c',
          'copy',
          '-y',
          output
        ]
        jobs.push({ args, output })
      } else {
        const args = [
          '-i',
          item.source,
          '-ss',
          item.start.toFixed(3),
          '-t',
          dur,
          '-c:v',
          opts.encoder!,
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          '-y',
          output
        ]
        jobs.push({ args, output })
      }
    })
  } else {
    // mode === 'concat'
    const output = path.join(opts.outDir, `${opts.baseName}.mp4`)
    const listLines: string[] = []

    for (const item of items) {
      listLines.push(`file ${escapeConcatPath(item.source)}`)
      listLines.push(`inpoint ${item.start.toFixed(3)}`)
      listLines.push(`outpoint ${item.end.toFixed(3)}`)
    }

    const listContent = listLines.join('\n') + '\n'

    if (effectiveQuality === 'copy') {
      const args = [
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        'LIST_FILE_PLACEHOLDER',
        '-c',
        'copy',
        '-y',
        output
      ]
      jobs.push({ args, output })
    } else {
      const args = [
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        'LIST_FILE_PLACEHOLDER',
        '-c:v',
        opts.encoder!,
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-y',
        output
      ]
      jobs.push({ args, output })
    }
  }

  return { jobs, notices }
}
