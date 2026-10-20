// @vitest-environment jsdom
// I13: show a notice when the source video cannot play (Relink/Back to Library) and make the buttons work; the Back action must also work for a notice with unknown language.
import { afterEach, describe, expect, test, vi } from 'vitest'
import { buttonByText, cleanupMounted, click, flush } from '../../../test/dom'
import { mountStudio, type StudioMount } from '../../../test/studioHarness'
import { i18n } from '../i18n'

let s: StudioMount | null = null
afterEach(() => {
  cleanupMounted()
  s?.restore()
  s = null
})
const N = i18n.studio.notices

describe('video missing notice (I13)', () => {
  test('A source-mode <video> error shows the notice; Back to Library calls onBack', async () => {
    const onBack = vi.fn()
    s = await mountStudio({ onBack })
    expect(document.querySelector('.notice')?.textContent ?? '').not.toContain(N.videoMissingTitle)
    document.querySelector('video')!.dispatchEvent(new Event('error'))
    await flush(10)
    const bar = document.querySelector('.notice')!
    expect(bar.textContent).toContain(N.videoMissingTitle)
    click(buttonByText(bar, N.back)!)
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  test('Relink File returns to the library with an explanatory toast', async () => {
    const onBack = vi.fn()
    s = await mountStudio({ onBack })
    document.querySelector('video')!.dispatchEvent(new Event('error'))
    await flush(10)
    click(buttonByText(document.querySelector('.notice')!, N.relink)!)
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.toast')?.textContent).toContain(i18n.studio.toast.relinkHint)
  })
})
