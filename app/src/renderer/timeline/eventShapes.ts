import type { EventType } from '../../shared/types'

export type ShapeKind = 'circle' | 'square' | 'hex' | 'diamond' | 'star'

export interface ShapeSpec {
  shape: ShapeKind
  /** 24×24 格線上的 SVG path 字串（以 3.2 px 粗筆畫描邊） */
  glyph: string
  /** tokens.css 的 CSS 變數名稱 */
  colorVar: string
}

/** 與 spec §5.2 一致：形狀＋顏色＋字形三重編碼 */
export const SHAPES: Record<EventType, ShapeSpec> = {
  knock: {
    shape: 'circle',
    glyph: 'M17 12a5 5 0 1 1-10 0a5 5 0 0 1 10 0z M12 3v4 M12 17v4 M3 12h4 M17 12h4',
    colorVar: '--ev-knock'
  },
  elim: {
    shape: 'square',
    glyph: 'M12 4a7 7 0 0 0-4 12.7V19h8v-2.3A7 7 0 0 0 12 4z M9.5 11.5h.01 M14.5 11.5h.01',
    colorVar: '--ev-elim'
  },
  assist_knock: {
    shape: 'hex',
    glyph: 'M12 5v14 M5 12h14',
    colorVar: '--ev-assist-knock'
  },
  assist_elim: {
    shape: 'diamond',
    glyph: 'M7 7l10 10 M17 7L7 17',
    colorVar: '--ev-assist-elim'
  },
  squad_wipe: {
    shape: 'star',
    glyph: 'M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z',
    colorVar: '--ev-squad-wipe'
  }
}

export const EVENT_TYPES = Object.keys(SHAPES) as EventType[]

/** 未知類型（引擎新增）退回 knock 外觀，避免畫布丟例外 */
export function shapeFor(type: string): ShapeSpec {
  return (SHAPES as Record<string, ShapeSpec>)[type] ?? SHAPES.knock
}

const glyphCache = new Map<string, Path2D>()
/** Path2D 延遲建立並快取（Node 測試環境無 Path2D，需先 stub） */
export function glyphPath(spec: ShapeSpec): Path2D {
  let p = glyphCache.get(spec.glyph)
  if (!p) {
    p = new Path2D(spec.glyph)
    glyphCache.set(spec.glyph, p)
  }
  return p
}

/** 在 (x,y) 以半徑 R 建立形狀路徑（beginPath 後呼叫端自行 fill/stroke） */
export function shapePath(g: CanvasRenderingContext2D, kind: ShapeKind, x: number, y: number, R: number): void {
  g.beginPath()
  if (kind === 'square') {
    g.roundRect(x - R + 1, y - R + 1, 2 * R - 2, 2 * R - 2, 4)
  } else if (kind === 'hex') {
    for (let k = 0; k < 6; k++) {
      const a = (Math.PI / 3) * k
      const px = x + Math.cos(a) * (R + 1)
      const py = y + Math.sin(a) * (R + 1)
      if (k) g.lineTo(px, py)
      else g.moveTo(px, py)
    }
    g.closePath()
  } else if (kind === 'diamond') {
    g.moveTo(x, y - R - 2)
    g.lineTo(x + R + 2, y)
    g.lineTo(x, y + R + 2)
    g.lineTo(x - R - 2, y)
    g.closePath()
  } else if (kind === 'star') {
    for (let k = 0; k < 10; k++) {
      const a = (Math.PI / 5) * k - Math.PI / 2
      const r = k % 2 ? R * 0.55 : R + 2
      const px = x + Math.cos(a) * r
      const py = y + Math.sin(a) * r
      if (k) g.lineTo(px, py)
      else g.moveTo(px, py)
    }
    g.closePath()
  } else {
    g.arc(x, y, R, 0, Math.PI * 2)
  }
}
