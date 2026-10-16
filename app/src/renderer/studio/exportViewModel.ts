import { Project } from '../editor/project'
import { concatCompatible, extraSecondsForCopy, StreamProbe } from '../../shared/exportCompat'
import { i18n } from '../i18n/zh-TW'

/** 來源影片規格（engine:probe 的回傳）；其餘串流參數 main 端沿用預設值，因此這裡只比對這三項。 */
export interface SourceInfo {
  codec: string
  width: number
  height: number
}

export interface ExportPlan {
  mode: 'concat' | 'separate'
  quality: 'copy' | 'precise'
  /** 以來源路徑為鍵；探測不到的來源不放（視為未知，不拿來判斷不一致） */
  sources: Record<string, SourceInfo | undefined>
  /** 以來源路徑為鍵的關鍵影格時間（目前只有已分析的目前影片有） */
  keyframes: Record<string, number[] | undefined>
  /** 來源缺失的片段 id（ProjectProvider.missingItemIds） */
  missingItemIds: ReadonlySet<string>
}

export interface Notice {
  kind: 'info' | 'warn'
  text: string
}

export interface ExportEncoders {
  encoders: string[]
  /** OpenH264 DLL 是否已安裝 */
  openh264: boolean
}

export interface ExportViewModel {
  notices: Notice[]
  copyAvailable: boolean
  /** 快速無損下各片段起點平均多出的秒數；非快速無損、或沒有關鍵影格資料＝null（不捏造數字） */
  extraSecondsHint: number | null
  canStart: boolean
  blockers: string[]
  /** 實際會採用的品質（合輯且來源不一致時，快速無損會自動改為精準） */
  effectiveQuality: 'copy' | 'precise'
  /** 需要先取得 OpenH264（精準重新編碼、沒有任何可用編碼器、且尚未安裝） */
  openh264Required: boolean
}

function toProbe(i: SourceInfo): StreamProbe {
  return { vcodec: i.codec, width: i.width, height: i.height, fps: 60, pix_fmt: 'yuv420p', acodec: 'aac', sample_rate: 48000, channels: 2 }
}

/** 匯出設定頁的衍生狀態（純函式）。相容性判斷沿用 shared/exportCompat（與 main 的 buildJobs 同一份）。 */
export function exportViewModel(project: Project, plan: ExportPlan | null, enc: ExportEncoders): ExportViewModel {
  const t = i18n.export
  const notices: Notice[] = []
  const blockers: string[] = []
  const items = project.items

  if (items.length === 0) blockers.push(t.blockEmpty)

  const missingSources: string[] = []
  if (plan) {
    for (const it of items) {
      if (plan.missingItemIds.has(it.id) && !missingSources.includes(it.source)) missingSources.push(it.source)
    }
  }
  for (const s of missingSources) blockers.push(t.blockMissingSource.replace('{path}', s))

  let copyAvailable = true
  if (plan && plan.mode === 'concat') {
    const probes: StreamProbe[] = []
    for (const it of items) {
      const info = plan.sources[it.source]
      if (info) probes.push(toProbe(info))
    }
    const check = concatCompatible(probes)
    if (!check.ok) {
      copyAvailable = false
      if (plan.quality === 'copy') {
        notices.push({ kind: 'warn', text: `${t.fallbackReencodeNotice}（${check.reason}）` })
      }
    }
  }

  const effectiveQuality: 'copy' | 'precise' = plan && plan.quality === 'copy' && copyAvailable ? 'copy' : 'precise'

  let extraSecondsHint: number | null = null
  if (plan && effectiveQuality === 'copy') {
    const gaps: number[] = []
    for (const it of items) {
      const kf = plan.keyframes[it.source]
      if (kf && kf.length > 0) gaps.push(extraSecondsForCopy(it.start, kf))
    }
    if (gaps.length > 0) extraSecondsHint = gaps.reduce((a, b) => a + b, 0) / gaps.length
  }

  const needsEncoder = plan !== null && effectiveQuality === 'precise'
  const noEncoder = enc.encoders.length === 0
  const openh264Required = needsEncoder && noEncoder && !enc.openh264
  if (needsEncoder && noEncoder && enc.openh264) blockers.push(t.blockNoEncoder)

  const canStart = plan !== null && items.length > 0 && missingSources.length === 0 && !(needsEncoder && noEncoder)
  return { notices, copyAvailable, extraSecondsHint, canStart, blockers, effectiveQuality, openh264Required }
}

/** 位元組 → 「1.6 GB」「212 MB」。 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 MB'
  const gb = n / 1024 ** 3
  if (gb >= 1) return `${gb >= 100 ? Math.round(gb) : gb.toFixed(1)} GB`
  return `${Math.max(1, Math.round(n / 1024 ** 2))} MB`
}

/** 剩餘空間是否不足（預估大小 × 1.1，與 main 的 checkDiskSpace 同一門檻）。 */
export function diskIsLow(freeBytes: number, estimateBytes: number): boolean {
  return freeBytes < estimateBytes * 1.1
}
