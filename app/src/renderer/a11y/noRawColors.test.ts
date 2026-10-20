import { describe, expect, test } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { relative, resolve, sep } from 'path'
import { RAW_COLOR_ALLOWLIST } from './rawColorAllowList'

const root = resolve(__dirname, '..')

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(resolve(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) && !/\.(test|bench)\.ts$/.test(e.name) ? [resolve(dir, e.name)] : []
  )
}

/** Remove comments before stripping string literals and other noise (comments may contain color values). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\'"`])\/\/.*$/gm, '$1')
}

const HEX = /#[0-9a-fA-F]{3,8}\b/g
const FUNC = /\b(?:rgba?|hsla?)\(\s*[\d.]/g

export function rawColorsIn(src: string): string[] {
  const code = stripComments(src)
  return [...(code.match(HEX) ?? []), ...(code.match(FUNC) ?? [])]
}

describe('rawColorsIn (the scanner itself)', () => {
  test('Finds hex and rgb()/rgba()/hsl() literals while ignoring comments and template expressions', () => {
    expect(rawColorsIn("const a = '#ff00aa'")).toHaveLength(1)
    expect(rawColorsIn("const a = '#fff'")).toHaveLength(1)
    expect(rawColorsIn('const a = `rgba(0, 0, 0, .5)`')).toHaveLength(1)
    expect(rawColorsIn("const a = 'hsl(10 20% 30%)'")).toHaveLength(1)
    expect(rawColorsIn('// #ff0000 in comment\n/* rgb(1,2,3) */ const a = 1')).toHaveLength(0)
    expect(rawColorsIn('const a = `rgba(${rgb}, ${alpha})`')).toHaveLength(0)
    expect(rawColorsIn("const id = '#root'")).toHaveLength(0)
  })
})

describe('TS/TSX must not contain color literals (colors come from tokens.css)', () => {
  const files = walk(root)
  const allowed = new Set(RAW_COLOR_ALLOWLIST.map((e) => e.file))

  test('Scans at least one file', () => {
    expect(files.length).toBeGreaterThan(50)
  })

  test('Contains no unregistered color literals', () => {
    const offenders: string[] = []
    for (const f of files) {
      const rel = relative(root, f).split(sep).join('/')
      if (allowed.has(rel)) continue
      const hits = rawColorsIn(readFileSync(f, 'utf-8'))
      if (hits.length) offenders.push(`${rel}: ${hits.join(', ')}`)
    }
    expect(offenders).toEqual([])
  })

  test('Allowlist has no stale entries (each entry contains a color literal and a reason)', () => {
    for (const e of RAW_COLOR_ALLOWLIST) {
      expect(e.reason.length).toBeGreaterThan(5)
      expect(rawColorsIn(readFileSync(resolve(root, e.file), 'utf-8')).length, e.file).toBeGreaterThan(0)
    }
  })
})
