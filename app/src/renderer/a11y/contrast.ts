// WCAG 2.x 對比計算與 CSS 變數解析（測試與設計規則檢查用；不進 runtime 路徑）。

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

/** 解析 `#rgb`／`#rrggbb`／`rgb()`／`rgba()`。 */
export function parseColor(input: string): Rgba {
  const s = input.trim().toLowerCase()
  let m = /^#([0-9a-f]{3})$/.exec(s)
  if (m) {
    const [r, g, b] = m[1].split('').map((c) => parseInt(c + c, 16))
    return { r, g, b, a: 1 }
  }
  m = /^#([0-9a-f]{6})$/.exec(s)
  if (m) {
    const n = parseInt(m[1], 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 }
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s)
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] }
  throw new Error(`unsupported color: ${input}`)
}

const hex2 = (n: number): string => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0')

/** 把前景以 alpha 疊在不透明背景上，回傳 `#rrggbb`。 */
export function composite(fg: string, alpha: number, bg: string): string {
  const f = parseColor(fg)
  const b = parseColor(bg)
  const a = alpha * f.a
  return `#${hex2(f.r * a + b.r * (1 - a))}${hex2(f.g * a + b.g * (1 - a))}${hex2(f.b * a + b.b * (1 - a))}`
}

function luminance(c: Rgba): number {
  const lin = (v: number): number => {
    const x = v / 255
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
}

/** WCAG 對比值；fg 若半透明須先用 composite 疊到 bg 上。 */
export function contrast(fg: string, bg: string): number {
  const l1 = luminance(parseColor(fg))
  const l2 = luminance(parseColor(bg))
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1]
  return (hi + 0.05) / (lo + 0.05)
}

/** 取出 CSS 中所有 `--name: value;` 宣告（忽略註解；同名後者覆蓋前者）。 */
export function parseCssVars(css: string): Record<string, string> {
  const out: Record<string, string> = {}
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const re = /(--[a-zA-Z0-9-]+)\s*:\s*([^;}]+);?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(clean))) out[m[1]] = m[2].trim()
  return out
}
