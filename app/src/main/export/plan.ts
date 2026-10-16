import path from 'path'
import { ProjectItem } from '../../renderer/editor/project'
import { estimateOutputBytes as estimateBytes } from '../../shared/exportEstimate'
import { concatCompatible, StreamProbe } from '../../shared/exportCompat'

// 相容性判斷搬到 shared（匯出抽屜在 renderer 也要用）；此處重新匯出維持原 import 路徑
export { concatCompatible, extraSecondsForCopy } from '../../shared/exportCompat'
export type { StreamProbe } from '../../shared/exportCompat'

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
