// @vitest-environment jsdom
// 匯出進行中的編輯鎖定：側欄、專案軌、來源時間軸一律 inert（不只是資料層默默拒絕），結束後解除。
import { afterEach, describe, expect, test } from 'vitest'
import { cleanupMounted, click, flush, focusEl, installDomShims, press } from '../../../test/dom'
import { mountStudio, STUDIO_VIDEO, type StudioMount } from '../../../test/studioHarness'

let s: StudioMount | null = null
afterEach(() => {
  cleanupMounted()
  s?.restore()
  s = null
})

const q = <T extends Element = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel)
const qa = <T extends Element = HTMLElement>(sel: string): T[] => Array.from(document.querySelectorAll<T>(sel))
const LOCKED = ['.studio-aside', '.studio-tl', '.plane-head-edit', '.project-lane .track']

describe('export lock', () => {
  test('while an export runs the side panel, project track and source timeline are inert; they unlock when it ends', async () => {
    installDomShims({ width: 1366, height: 768 })
    let finish: (r: unknown) => void = () => undefined
    s = await mountStudio({
      items: [
        { id: 'i1', source: STUDIO_VIDEO, start: 10, end: 20 },
        { id: 'i2', source: STUDIO_VIDEO, start: 100, end: 112 }
      ],
      api: {
        settings: { defaultOutDir: 'D:/out' },
        overrides: { export: { start: () => new Promise((r) => (finish = r)) } }
      }
    })
    for (const sel of LOCKED) expect(q(sel)!.hasAttribute('inert'), `${sel} before`).toBe(false)

    focusEl(qa('.pclip')[0])
    press(document.activeElement as Element, 'E', { ctrlKey: true, shiftKey: true })
    await flush(30)
    const start = q<HTMLButtonElement>('.xd-foot .btn-accent')!
    expect(start.disabled).toBe(false)
    click(start)
    await flush(30)
    expect(q('.xd')!.getAttribute('data-phase')).toBe('running')

    for (const sel of LOCKED) {
      const el = q(sel)!
      expect(el.hasAttribute('inert'), `${sel} inert`).toBe(true)
      expect(el.getAttribute('aria-disabled'), `${sel} aria-disabled`).toBe('true')
    }
    // 徽章狀態：專案軌匯出按鈕顯示進度
    expect(q('.plane-head .xd-badge')?.textContent).toContain('%')

    // 縮小抽屜、收起再展開側欄：新掛載的側欄也必須是 inert
    press(document.activeElement ?? document.body, 'Escape')
    expect(q('.xd')).toBeNull()
    const exportButton = q('.plane-head > .btn-accent')!
    expect(exportButton.closest('[inert]')).toBeNull()
    click(exportButton)
    expect(q('.xd')).not.toBeNull()
    press(document.activeElement ?? document.body, 'Escape')
    press(document.body, 'b', { ctrlKey: true })
    expect(q('.studio-aside')).toBeNull()
    press(document.body, 'b', { ctrlKey: true })
    expect(q('.studio-aside')!.hasAttribute('inert')).toBe(true)

    // 資料層仍拒絕異動（Delete 不會移除片段）
    const chip = qa('.pclip')[0]
    press(chip, 'Delete')
    expect(qa('.pclip').length).toBe(2)

    finish({ ok: true, outputs: ['D:/out/x.mp4'] })
    await flush(30)
    for (const sel of LOCKED) expect(q(sel)!.hasAttribute('inert'), `${sel} after`).toBe(false)
    expect(q('.studio-aside')!.hasAttribute('aria-disabled')).toBe(false)
  })
})
