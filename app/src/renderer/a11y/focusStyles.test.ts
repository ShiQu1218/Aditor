import { describe, expect, test } from 'vitest'
import fs from 'fs'
import path from 'path'

const STYLES = path.resolve(__dirname, '..', 'styles')
const files = fs.readdirSync(STYLES).filter((f) => f.endsWith('.css') && f !== 'tokens.css')

interface Rule {
  file: string
  selector: string
  body: string
}

function rulesOf(file: string): Rule[] {
  const css = fs.readFileSync(path.join(STYLES, file), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '')
  const out: Rule[] = []
  for (const m of css.matchAll(/([^{}@][^{}]*)\{([^{}]*)\}/g)) {
    out.push({ file, selector: m[1].trim().replace(/\s+/g, ' '), body: m[2] })
  }
  return out
}

const all = files.flatMap(rulesOf)
const hidesOutline = (r: Rule): boolean => /(^|;|\s)outline\s*:\s*(none|0)\b/.test(r.body)
const showsFocus = (r: Rule): boolean => /box-shadow\s*:/.test(r.body) || /outline\s*:\s*(?!none|0\b)[^;]+/.test(r.body)

describe('visible focus (spec §3.8, Task 12 review)', () => {
  test('the global :focus-visible rule draws the --focus-ring token', () => {
    const base = all.find((r) => r.selector === ':focus-visible')
    expect(base).toBeTruthy()
    expect(base!.body).toContain('var(--focus-ring)')
  })

  const hiding = all.filter(hidesOutline)

  test('there are outline:none rules to audit (guards against the regex silently matching nothing)', () => {
    expect(hiding.length).toBeGreaterThan(3)
  })

  test.each(hiding.map((r) => [`${r.file}: ${r.selector}`, r] as const))('%s has a visible :focus-visible replacement', (_name, r) => {
    // The rule itself is :focus-visible (and draws the focus ring).
    if (/:focus-visible/.test(r.selector)) {
      expect(showsFocus(r), 'the :focus-visible rule hides the outline but draws nothing').toBe(true)
      return
    }
    // Other states, including :focus, must have a :focus-visible rule on the same element to draw the focus indicator.
    const bases = r.selector.split(',').map((x) => x.trim().replace(/:focus(-within)?$/, ''))
    for (const b of bases) {
      const replacement = all.find((x) => x.selector.split(',').map((y) => y.trim()).includes(`${b}:focus-visible`) && showsFocus(x))
      expect(replacement, `no ${b}:focus-visible rule that draws a ring`).toBeTruthy()
    }
  })

  test('focus replacements use tokens only (no raw colours)', () => {
    for (const r of all.filter((x) => /:focus/.test(x.selector) && !x.selector.includes('::'))) {
      expect(r.body, `${r.file}: ${r.selector}`).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/)
    }
  })

  test.each(['.pclip', '.sc-body', '.xd'])('%s has an inset focus ring (clipped containers cannot hide it)', (sel) => {
    const rule = all.find((r) => r.selector.split(',').map((x) => x.trim()).includes(`${sel}:focus-visible`))
    expect(rule, sel).toBeTruthy()
    expect(rule!.body).toMatch(/inset/)
  })
})
