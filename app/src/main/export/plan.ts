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
  /** 中間檔（正規化後的單段）：不算成品，結束後刪除 */
  intermediate?: boolean
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
): { jobs: FfmpegJob[]; notices: string[]; concatListContent?: string } {
  const notices: string[] = []
  let effectiveQuality = opts.quality

  if (opts.mode === 'concat' && opts.quality === 'copy') {
    // 同一來源只比對一次
    const probeList = [...new Set(items.map((it) => it.source))].map((src) => probes.get(src)).filter((p): p is StreamProbe => !!p)
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
        // -ss 放在 -i 前面：轉碼時同樣是精準 seek，但不必從檔頭解碼到起點（I8）
        const args = [
          '-ss',
          item.start.toFixed(3),
          '-i',
          item.source,
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
    if (effectiveQuality === 'precise' && needsNormalize(items, probes)) {
      return buildNormalizedConcat(items, opts, probes, notices)
    }
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

function needsNormalize(items: ProjectItem[], probes: Map<string, StreamProbe>): boolean {
  const sources = [...new Set(items.map((it) => it.source))]
  if (sources.length <= 1) return false
  const list = sources.map((src) => probes.get(src)).filter((p): p is StreamProbe => !!p)
  return list.length < sources.length || !concatCompatible(list).ok
}

/**
 * 多來源且規格不一定相同的精準合併：concat demuxer 會用第一個檔案的解碼器解全部輸入，來源的 codec／解析度／幀率不同就會壞掉。
 * 所以每段先轉成相同規格（解析度、幀率、像素格式、音訊取樣率與聲道）的中間檔，最後用 concat demuxer 直接 copy。
 */
function buildNormalizedConcat(
  items: ProjectItem[],
  opts: { outDir: string; baseName: string; encoder?: string },
  probes: Map<string, StreamProbe>,
  notices: string[]
): { jobs: FfmpegJob[]; notices: string[]; concatListContent: string } {
  const first = probes.get(items[0].source)
  const w = first && first.width > 0 ? first.width : 1920
  const h = first && first.height > 0 ? first.height : 1080
  const fps = first && first.fps > 0 ? first.fps : 60
  const vf = [
    `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,
    `fps=${fps}`,
    'format=yuv420p'
  ].join(',')
  const tag = Math.random().toString(36).slice(2, 8)
  const jobs: FfmpegJob[] = []
  const list: string[] = []
  items.forEach((item, idx) => {
    const output = path.join(opts.outDir, `.apexhl-seg-${tag}-${idx + 1}.mp4`)
    const dur = Math.max(0.1, item.end - item.start).toFixed(3)
    jobs.push({
      intermediate: true,
      output,
      args: ['-ss', item.start.toFixed(3), '-i', item.source, '-t', dur, '-vf', vf, '-c:v', opts.encoder!, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-y', output]
    })
    list.push(`file ${escapeConcatPath(output)}`)
  })
  const output = path.join(opts.outDir, `${opts.baseName}.mp4`)
  jobs.push({ output, args: ['-f', 'concat', '-safe', '0', '-i', 'LIST_FILE_PLACEHOLDER', '-c', 'copy', '-y', output] })
  notices.push('來源規格不同，已先將每段轉成相同規格再合併')
  return { jobs, notices, concatListContent: list.join('\n') + '\n' }
}

/**
 * 找一個不會覆蓋既有檔案的檔名主體（I6）：依序嘗試 `<base>`、`<base> (2)`、`<base> (3)`…，
 * 直到該模式會產生的所有輸出檔都不存在。
 */
export function resolveFreeBaseName(
  outDir: string,
  baseName: string,
  mode: 'separate' | 'concat',
  count: number,
  exists: (p: string) => boolean
): { baseName: string; renamed: boolean } {
  const outputs = (b: string): string[] =>
    mode === 'separate' ? Array.from({ length: count }, (_, i) => path.join(outDir, `${b}_${i + 1}.mp4`)) : [path.join(outDir, `${b}.mp4`)]
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? baseName : `${baseName} (${n})`
    if (!outputs(candidate).some(exists)) return { baseName: candidate, renamed: n > 1 }
  }
  return { baseName: `${baseName} (${Date.now()})`, renamed: true }
}
