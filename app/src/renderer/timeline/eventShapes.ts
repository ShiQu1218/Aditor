import type { EventType } from '../../shared/types'

export type ShapeKind = 'circle' | 'square' | 'hex' | 'diamond' | 'star'

export interface ShapeSpec {
  shape: ShapeKind
/** SVG path strings on a 24×24 grid (stroked with a 3.2 px line). */
  glyph: string
/** CSS variable names from tokens.css. */
  colorVar: string
}

/** Triple encoding by shape, color, and glyph, matching spec §5.2. */
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
  },
  // Valorant: a kill reads like an Apex knock (the player's own frag); multikill/ace borrow the elim/squad-wipe colors.
  kill: {
    shape: 'circle',
    glyph: 'M17 12a5 5 0 1 1-10 0a5 5 0 0 1 10 0z M12 3v4 M12 17v4 M3 12h4 M17 12h4',
    colorVar: '--ev-knock'
  },
  death: {
    shape: 'square',
    glyph: 'M12 4a7 7 0 0 0-4 12.7V19h8v-2.3A7 7 0 0 0 12 4z M9.5 11.5h.01 M14.5 11.5h.01',
    colorVar: '--ev-death'
  },
  multikill: {
    shape: 'diamond',
    glyph: 'M13 3L6 13h5l-1 8 7-10h-5z',
    colorVar: '--ev-elim'
  },
  ace: {
    shape: 'star',
    glyph: 'M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z',
    colorVar: '--ev-squad-wipe'
  }
}

export const EVENT_TYPES = Object.keys(SHAPES) as EventType[]

/** Fall back to the knock appearance for unknown types (added by the engine) to avoid canvas errors. */
export function shapeFor(type: string): ShapeSpec {
  return (SHAPES as Record<string, ShapeSpec>)[type] ?? SHAPES.knock
}

const glyphCache = new Map<string, Path2D>()
/** Create and cache Path2D lazily (the Node test environment lacks Path2D, so tests must stub it). */
export function glyphPath(spec: ShapeSpec): Path2D {
  let p = glyphCache.get(spec.glyph)
  if (!p) {
    p = new Path2D(spec.glyph)
    glyphCache.set(spec.glyph, p)
  }
  return p
}

/** Create a shape path at (x,y) with radius R; the caller fills/strokes it after beginPath. */
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
