import type { Clip, EngineEvent, EventType, SpecInterval } from '../../shared/types'
import { isCounted } from '../../shared/types'
import { formatTime } from '../../shared/time'
import { i18n } from '../i18n/zh-TW'
import type { TimelineLayout } from './layout'
import { View, timeToX } from './model'
import { heatBinCount } from '../perf/lowPerf'
import { EVENT_TYPES, SHAPES, glyphPath, shapeFor, shapePath } from './eventShapes'

export type Ctx2D = CanvasRenderingContext2D

/** 垂直版面（spec §3.2.2）：尺標 0–21、標籤列 22–38、事件／框區 38–底 */
export const RULER_H = 21
export const CLIP_LABEL_ROW = { y: 24, h: 14 }
export const EVENT_TOP = 40
const BOTTOM_PAD = 6
const ICON_Y = 66
const ICON_R = 10
const HANDLE_W = 6
const NARROW_CLIP_PX = 12
const RULER_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800]

export interface Theme {
  font: string
  bg: string
  line: string
  lineStrong: string
  text1: string
  text2: string
  text3: string
  popover: string
  /** 實心圖示上的字形顏色（深色） */
  onShape: string
  spectatingFill: string
  spectatingHatch: string
  unanalyzed: string
  /** 'r, g, b'，搭配 alpha 組成 rgba() */
  heatRgb: string
  clipSuggestLine: string
  clipSuggestFill: string
  clipLine: string
  clipFill: string
  events: Record<EventType, string>
}

export interface DrawModel {
  width: number
  height: number
  view: View
  duration: number
  layout: TimelineLayout
  spectating: SpecInterval[]
  clips: Clip[]
  selected: Set<string>
  /** 目前播放位置所在的事件（畫外環） */
  currentId?: string
  /** v1 不使用（不做部分分析檢視）；有值時才畫 */
  unanalyzed?: SpecInterval[]
  hoverClipId?: string | null
  activeClipId?: string | null
  /** 低效能模式：熱度條降為 HEAT_BINS_LOWPERF 格 */
  lowPerf?: boolean
}

/* ---------------- Theme：由 CSS 變數讀出一次並快取 ---------------- */

let cachedTheme: Theme | null = null

/** 僅供測試使用：單一深色主題，執行期不需要因 token 變更而重讀 */
export function resetThemeCache(): void {
  cachedTheme = null
}

function defaultGetVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

export function readTheme(getVar: (name: string) => string = defaultGetVar): Theme {
  if (cachedTheme) return cachedTheme
  const events = {} as Record<EventType, string>
  for (const t of EVENT_TYPES) events[t] = getVar(SHAPES[t].colorVar)
  cachedTheme = {
    font: `11px ${getVar('--font-ui')}`,
    bg: getVar('--tl-bg'),
    line: getVar('--line'),
    lineStrong: getVar('--line-strong'),
    text1: getVar('--text-1'),
    text2: getVar('--text-2'),
    text3: getVar('--text-3'),
    popover: getVar('--bg-popover'),
    onShape: getVar('--bg-app'),
    spectatingFill: getVar('--tl-spectating-fill'),
    spectatingHatch: getVar('--tl-spectating-hatch'),
    unanalyzed: getVar('--tl-unanalyzed'),
    heatRgb: getVar('--tl-heat'),
    clipSuggestLine: getVar('--tl-clip-suggest-line'),
    clipSuggestFill: getVar('--tl-clip-suggest-fill'),
    clipLine: getVar('--tl-clip-line'),
    clipFill: getVar('--tl-clip-fill'),
    events
  }
  return cachedTheme
}

/* ---------------- 重繪排程：多次 invalidate 合併為一個 rAF ---------------- */

export function createRedrawScheduler(
  draw: () => void,
  raf: (cb: () => void) => number = (cb) => requestAnimationFrame(cb),
  cancel: (id: number) => void = (id) => cancelAnimationFrame(id)
): { invalidate: () => void; dispose: () => void } {
  let pending: number | null = null
  return {
    invalidate() {
      if (pending !== null) return
      pending = raf(() => {
        pending = null
        draw()
      })
    },
    dispose() {
      if (pending !== null) cancel(pending)
      pending = null
    }
  }
}

/* ---------------- 繪製 ---------------- */

function drawRuler(g: Ctx2D, m: DrawModel, th: Theme): void {
  const { view, width } = m
  if (width <= 0 || view.span <= 0) return
  const step = RULER_STEPS.find((s) => view.span / s <= width / 80) ?? 1800
  g.fillStyle = th.text3
  g.strokeStyle = th.lineStrong
  g.lineWidth = 1
  const end = view.start + view.span
  for (let t = Math.ceil(view.start / step) * step; t <= end; t += step) {
    const x = Math.round(timeToX(t, view)) + 0.5
    g.beginPath()
    g.moveTo(x, 14)
    g.lineTo(x, RULER_H)
    g.stroke()
    g.fillText(formatTime(t), x + 3, 2)
  }
  g.strokeStyle = th.line
  g.beginPath()
  g.moveTo(0, RULER_H + 0.5)
  g.lineTo(width, RULER_H + 0.5)
  g.stroke()
}

function drawSpectating(g: Ctx2D, m: DrawModel, th: Theme): void {
  const { view, width, height } = m
  const top = RULER_H + 1
  for (const s of m.spectating) {
    const x0 = timeToX(s.start, view)
    const x1 = timeToX(s.end, view)
    if (x1 < 0 || x0 > width) continue
    g.save()
    g.beginPath()
    g.rect(x0, top, Math.max(2, x1 - x0), height - top)
    g.clip()
    g.fillStyle = th.spectatingFill
    g.fillRect(x0, top, x1 - x0, height - top)
    g.strokeStyle = th.spectatingHatch
    g.lineWidth = 1
    for (let x = x0 - height; x < x1 + height; x += 8) {
      g.beginPath()
      g.moveTo(x, height)
      g.lineTo(x + height, top)
      g.stroke()
    }
    g.restore()
    if (x1 - x0 > 90) {
      g.fillStyle = th.text2
      g.fillText(i18n.timeline.spectating, x0 + 4, height - 20)
    }
  }
}

function drawUnanalyzed(g: Ctx2D, m: DrawModel, th: Theme): void {
  if (!m.unanalyzed) return
  g.fillStyle = th.unanalyzed
  for (const r of m.unanalyzed) {
    const x0 = timeToX(r.start, m.view)
    const x1 = timeToX(r.end, m.view)
    if (x1 < 0 || x0 > m.width) continue
    g.fillRect(x0, RULER_H + 1, Math.max(1, x1 - x0), m.height - RULER_H - 1)
  }
}

function drawHeat(g: Ctx2D, m: DrawModel, th: Theme, bot: number): void {
  const density = m.layout.mode === 'density'
  const nb = heatBinCount(m.width, density, Boolean(m.lowPerf))
  if (nb <= 0) return
  // 一般模式每格固定 4／6 px；低效能模式把整個寬度均分成 60 格
  const binPx = m.lowPerf ? m.width / nb : density ? 4 : 6
  const counts = new Float32Array(nb)
  let max = 0
  for (const it of m.layout.items) {
    for (const e of it.events) {
      if (!isCounted(e)) continue
      const x = timeToX(e.t, m.view)
      if (x < 0 || x >= m.width) continue
      const b = Math.min(nb - 1, Math.floor(x / binPx))
      counts[b]++
      if (counts[b] > max) max = counts[b]
    }
  }
  const maxH = density ? 46 : 16
  for (let i = 0; i < nb; i++) {
    if (!counts[i]) continue
    const k = counts[i] / max
    const h = 3 + k * (maxH - 3)
    g.fillStyle = `rgba(${th.heatRgb}, ${0.35 + k * 0.55})`
    g.fillRect(i * binPx, bot - h, Math.max(1, binPx - 1), h)
  }
}

function drawClips(g: Ctx2D, m: DrawModel, th: Theme, bot: number): void {
  const { view, width } = m
  const boxH = bot - EVENT_TOP
  for (const c of m.clips) {
    if (c.status === 'skipped') continue
    const x0 = timeToX(c.start, view)
    const x1 = timeToX(c.end, view)
    if (x1 < 0 || x0 > width) continue
    const suggested = c.status === 'suggested'
    const emphasised = m.hoverClipId === c.id || m.activeClipId === c.id
    const w = x1 - x0
    if (w < NARROW_CLIP_PX) {
      // 縮小檢視：實心窄條，不畫虛線框（避免雜訊）
      g.globalAlpha = suggested ? 0.4 : 0.8
      g.fillStyle = suggested ? th.clipSuggestLine : th.clipLine
      g.fillRect(x0, EVENT_TOP, Math.max(3, w), boxH)
      g.globalAlpha = 1
    } else {
      g.fillStyle = suggested ? th.clipSuggestFill : th.clipFill
      g.fillRect(x0, EVENT_TOP, w, boxH)
      g.strokeStyle = suggested ? th.clipSuggestLine : th.clipLine
      g.lineWidth = suggested ? 1.5 : 2
      g.setLineDash(suggested ? [5, 3] : [])
      g.strokeRect(x0 + 0.5, EVENT_TOP + 0.5, Math.max(1, w), boxH - 1)
      g.setLineDash([])
    }
    if (emphasised) {
      g.fillStyle = th.text1
      g.fillRect(x0 - 2, EVENT_TOP + 6, HANDLE_W, boxH - 12)
      g.fillRect(x1 - 4, EVENT_TOP + 6, HANDLE_W, boxH - 12)
    }
    // 標籤獨立一行（在框上緣之上），寬度不足則省略
    const label =
      (suggested ? '' : '✓ ') + (c.origin === 'ai' ? i18n.timeline.clipAi + ' ' : '') + formatTime(c.end - c.start)
    const lw = g.measureText(label).width + 8
    if (w > lw - 4) {
      g.fillStyle = suggested ? th.popover : th.clipLine
      g.fillRect(x0, CLIP_LABEL_ROW.y, lw, CLIP_LABEL_ROW.h)
      g.fillStyle = suggested ? th.text1 : th.onShape
      g.fillText(label, x0 + 4, CLIP_LABEL_ROW.y + 1)
    }
  }
}

function drawDensityEvents(g: Ctx2D, m: DrawModel, th: Theme): void {
  const sel = m.selected
  for (const it of m.layout.items) {
    const e = it.events[0]
    const x = Math.round(timeToX(e.t, m.view))
    if (sel.has(e.id)) {
      g.fillStyle = th.text1
      g.fillRect(x - 1, EVENT_TOP + 6, 4, 14)
    }
    g.globalAlpha = isCounted(e) ? 1 : 0.65
    g.fillStyle = th.events[e.type as EventType] ?? th.events.knock
    g.fillRect(x, EVENT_TOP + 8, 2, 10)
  }
  g.globalAlpha = 1
  g.fillStyle = th.text3
  g.fillText(i18n.timeline.densityHint.replace('{n}', String(m.layout.visibleCount)), 8, CLIP_LABEL_ROW.y)
}

function drawSingle(g: Ctx2D, e: EngineEvent, x: number, m: DrawModel, th: Theme, bot: number): void {
  const spec = shapeFor(e.type)
  const color = th.events[e.type as EventType] ?? th.events.knock
  const on = isCounted(e)
  const y = ICON_Y
  // 垂直引線
  g.strokeStyle = th.lineStrong
  g.lineWidth = 1
  g.beginPath()
  g.moveTo(x, y + ICON_R + 2)
  g.lineTo(x, bot - 18)
  g.stroke()

  shapePath(g, spec.shape, x, y, ICON_R)
  if (on) {
    g.globalAlpha = 1
    g.fillStyle = color
    g.fill()
  } else {
    // 不計入：14% 淡底＋65% 不透明＋2px 同色描邊
    g.globalAlpha = 0.65 * 0.14
    g.fillStyle = color
    g.fill()
    g.globalAlpha = 0.65
    g.strokeStyle = color
    g.lineWidth = 2
    g.stroke()
  }
  g.save()
  g.translate(x - 8, y - 8)
  g.scale(16 / 24, 16 / 24)
  g.lineWidth = 3.2
  g.lineCap = 'round'
  g.lineJoin = 'round'
  g.strokeStyle = on ? th.onShape : color
  g.stroke(glyphPath(spec))
  g.restore()
  g.globalAlpha = 1

  if (m.currentId === e.id || m.selected.has(e.id)) {
    g.strokeStyle = th.text1
    g.lineWidth = 2
    g.beginPath()
    g.arc(x, y, ICON_R + 5, 0, Math.PI * 2)
    g.stroke()
  }
}

function drawCluster(g: Ctx2D, events: EngineEvent[], x: number, m: DrawModel, th: Theme): void {
  const n = events.length
  const label = '×' + n
  const w = g.measureText(label).width + 16
  const y = ICON_Y
  // 依各類型的事件數分段上色；未知類型沿用單一事件的擊倒色
  const segments = new Map<string, { count: number; counted: number }>()
  for (const e of events) {
    const color = th.events[e.type as EventType] ?? th.events.knock
    const segment = segments.get(color) ?? { count: 0, counted: 0 }
    segment.count++
    if (isCounted(e)) segment.counted++
    segments.set(color, segment)
  }
  g.save()
  g.beginPath()
  g.roundRect(x - w / 2, y - 10, w, 20, 10)
  g.clip()
  let left = x - w / 2
  for (const [color, segment] of segments) {
    const width = w * segment.count / n
    g.globalAlpha = segment.counted > 0 ? 1 : 0.65
    g.fillStyle = color
    g.fillRect(left, y - 10, width, 20)
    left += width
  }
  g.restore()
  g.globalAlpha = 1
  g.strokeStyle = th.text1
  g.lineWidth = 1.5
  g.beginPath()
  g.roundRect(x - w / 2, y - 10, w, 20, 10)
  g.stroke()
  g.fillStyle = th.onShape
  g.textBaseline = 'middle'
  g.fillText(label, x - w / 2 + 8, y + 1)
  g.textBaseline = 'top'
  // 計入比例小條
  left = x - w / 2 + 4
  for (const [color, segment] of segments) {
    const width = (w - 8) * segment.counted / n
    if (width === 0) continue
    g.fillStyle = color
    g.fillRect(left, y + 14, width, 2)
    left += width
  }
  if (events.some((e) => m.selected.has(e.id) || m.currentId === e.id)) {
    g.strokeStyle = th.text1
    g.lineWidth = 2
    g.beginPath()
    g.roundRect(x - w / 2 - 3, y - 13, w + 6, 26, 13)
    g.stroke()
  }
}

function drawIconEvents(g: Ctx2D, m: DrawModel, th: Theme, bot: number): void {
  for (const it of m.layout.items) {
    if (it.events.length === 1) drawSingle(g, it.events[0], it.x, m, th, bot)
    else drawCluster(g, it.events, it.x, m, th)
  }
}

/** 靜態層繪製（播放頭是 DOM 元素，不在此畫）。呼叫端須先設好 DPR transform。 */
export function drawTimeline(g: Ctx2D, m: DrawModel, th: Theme): void {
  const { width, height } = m
  const bot = height - BOTTOM_PAD
  g.clearRect(0, 0, width, height)
  g.fillStyle = th.bg
  g.fillRect(0, 0, width, height)
  g.font = th.font
  g.textBaseline = 'top'
  g.globalAlpha = 1

  drawRuler(g, m, th)
  drawSpectating(g, m, th)
  drawUnanalyzed(g, m, th)
  drawHeat(g, m, th, bot)
  drawClips(g, m, th, bot)
  if (m.layout.mode === 'density') drawDensityEvents(g, m, th)
  else drawIconEvents(g, m, th, bot)
}
