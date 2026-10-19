// axe-core (jsdom) helper: report only serious/critical violations and list disabled rules with their rationale.
import axe, { type Result, type RunOptions } from 'axe-core'

/**
 * jsdom does not perform layout or drawing, so these rules cannot produce reliable results here and are disabled
 * (their guarantees are covered elsewhere):
 * - color-contrast: Requires actual color and layout calculations. a11y/contrast.test.ts checks the full tokens.css
 *   matrix (spec §5.1).
 * - color-contrast-enhanced: Same as above (AAA, outside this project's goals).
 * - target-size: Requires actual element dimensions. The minimum target sizes are defined in CSS (26/32 px) and
 *   spec §3.8; jsdom reports 0×0 for every element.
 * - scrollable-region-focusable: Requires scrollHeight/clientHeight; jsdom always reports 0, so this never fires
 *   (disabled to avoid false confidence). Component tests cover keyboard access using container tabIndex and
 *   focusable descendants.
 * - landmark-*, region, and page-has-heading-one: Page-level best practices (moderate); component tests mount fragments only.
 */
export const DISABLED_RULES: Record<string, string> = {
  'color-contrast': 'jsdom has no layout/paint; contrast is locked by a11y/contrast.test.ts against tokens.css',
  'color-contrast-enhanced': 'same as color-contrast (AAA, not a target)',
  'target-size': 'needs real element geometry; jsdom reports 0x0 for everything',
  'scrollable-region-focusable': 'needs scrollHeight/clientHeight; jsdom always reports 0 so it can never fire',
  region: 'page-level best practice (moderate); component tests mount fragments',
  'landmark-one-main': 'page-level best practice; fragments',
  'landmark-no-duplicate-main': 'page-level best practice; fragments',
  'landmark-unique': 'page-level best practice; fragments',
  'page-has-heading-one': 'page-level best practice (moderate); fragments'
}

export interface AxeFinding {
  id: string
  impact: string
  help: string
  nodes: string[]
}

export async function runAxe(root: Element | Document = document): Promise<AxeFinding[]> {
  const rules: RunOptions['rules'] = {}
  for (const id of Object.keys(DISABLED_RULES)) rules[id] = { enabled: false }
  const res = await axe.run(root as axe.ElementContext, { rules, resultTypes: ['violations'] })
  return res.violations
    .filter((v: Result) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({
      id: v.id,
      impact: String(v.impact),
      help: v.help,
      nodes: v.nodes.map((n) => `${n.target.join(' ')} :: ${n.html.slice(0, 160)}`)
    }))
}

export function formatFindings(f: AxeFinding[]): string {
  return f.map((x) => `[${x.impact}] ${x.id}: ${x.help}\n  ${x.nodes.join('\n  ')}`).join('\n')
}
