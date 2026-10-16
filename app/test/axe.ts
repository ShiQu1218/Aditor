// axe-core（jsdom）輔助：只回報 serious／critical 違規，並列出停用的規則與理由。
import axe, { type Result, type RunOptions } from 'axe-core'

/**
 * jsdom 不做版面與繪圖，下列規則在這裡無法得到可信結果，因此停用（其保證改由別處鎖定）：
 * - color-contrast：需要實際算色／版面。對比由 a11y/contrast.test.ts 鎖定 tokens.css 的整個矩陣（spec §5.1）。
 * - color-contrast-enhanced：同上（AAA，非本專案目標）。
 * - target-size：需要元素實際尺寸；最小點擊目標以 CSS（26/32 px）與 spec §3.8 為準，jsdom 全部回 0×0。
 * - scrollable-region-focusable：需要 scrollHeight/clientHeight；jsdom 恆為 0，永遠不會觸發（停用以免給人假安心）；
 *   可捲動區域的鍵盤可達性改由「容器 tabIndex／內含可聚焦子項」的元件測試鎖定。
 * - landmark-*／region／page-has-heading-one：頁面級最佳實務（moderate），元件測試只掛載片段。
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
