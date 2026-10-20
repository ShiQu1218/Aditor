import React from 'react'
import { renderToString } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { CacheDoc } from '../../shared/types'
import { ProjectProvider } from '../editor/ProjectProvider'
import { OverlayProvider } from '../shell/OverlayHost'
import { ToastProvider } from '../shell/ToastHost'
import { StudioScreen } from './StudioScreen'
import { StudioBlockedView, StudioLoadErrorView, StudioLoadingView } from './StudioStates'

/** renderToString does not run effects; verify only the initial render structure and wiring (jsdom is not needed). */
const calls: string[] = []
const fakeApi = new Proxy(
  {},
  {
    get: (_t, ns: string) =>
      new Proxy(
        {},
        {
          get: (_u, fn: string) => (...args: unknown[]) => {
            calls.push(`${ns}.${fn}`)
            void args
            return Promise.resolve(null)
          }
        }
      )
  }
)

const doc: CacheDoc = {
  version: 1,
  video: { path: 'C:/v/a.mp4', size: 1, mtime: 1, duration: 600, width: 1920, height: 1080, codec: 'h264', start_time: 0 },
  profile: 'zh-TW',
  analysis: { status: 'done', progress_t: 600, engine_version: '0.1.0', templates_version: 'zh-TW@1', h_scale: 1 },
  events: [
    { id: 'e1', t: 30, type: 'knock', conf: 0.9, counted: true, deleted: false },
    { id: 'e2', t: 90, type: 'elim', conf: 0.9, counted: true, deleted: false }
  ],
  spectating: [],
  clips: [],
  keyframes: [],
  cache_path: 'C:/cache/x.json'
} as unknown as CacheDoc

function render(props: { preloadedDoc?: CacheDoc } = {}): string {
  return renderToString(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(
        OverlayProvider,
        null,
        React.createElement(
          ProjectProvider,
          null,
          React.createElement(StudioScreen, { videoPath: 'C:\\v\\a.mp4', onBack: () => undefined, onOpenVideo: () => undefined, ...props })
        )
      )
    )
  )
}

const g = globalThis as unknown as { window?: unknown }
let prevWindow: unknown
beforeAll(() => {
  prevWindow = g.window
  g.window = { api: fakeApi }
})
afterAll(() => {
  g.window = prevWindow
})

describe('StudioScreen SSR smoke', () => {
  test('loaded: source mode shell, zones, video bound to the source file', () => {
    const out = render({ preloadedDoc: doc })
    expect(out).toContain('class="studio"')
    expect(out).toContain('data-zone="src"') // Source timeline.
    expect(out).toContain('data-zone="proj"') // Project timeline.
    expect(out).toContain('src="file://C:/v/a.mp4"')
    expect(out).toContain('來源 · a.mp4') // Mode pill.
    expect(out).not.toContain('role="alert"') // No blocked/error screen.
    expect(out).toContain('2 個事件') // Comes from the loaded document, not a fabricated default.
  })

  test('not loaded yet: shows the loading view, never the fake default doc (1920×1080 / 100s)', () => {
    const out = render()
    expect(out).toContain('載入分析結果')
    expect(out).not.toContain('class="stage"')
    expect(out).not.toContain('<video')
    expect(out).not.toContain('1920×1080')
  })

  test('render performs no engine/cache IPC (loading runs in effects, status-checked first)', () => {
    calls.length = 0
    render({ preloadedDoc: doc })
    render()
    expect(calls.filter((c) => c.startsWith('engine.') || c.startsWith('cache.'))).toEqual([])
  })
})

describe('StudioStates', () => {
  const noop = (): void => undefined
  const html = (el: React.ReactElement): string => renderToString(el)

  test('Error view carries the code and Back to Library/retry actions', () => {
    const out = html(React.createElement(StudioLoadErrorView, { code: 3, onRetry: noop, onCopy: noop, onBack: noop }))
    expect(out).toContain('role="alert"')
    expect(out).toContain('代碼 3')
    expect(out).toContain('返回影片庫')
    expect(out).toContain('重試')
  })

  test('error without a code says unknown', () => {
    const out = html(React.createElement(StudioLoadErrorView, { onRetry: noop, onCopy: noop, onBack: noop }))
    expect(out).toContain('unknown')
  })

  test('blocked and loading views', () => {
    expect(html(React.createElement(StudioBlockedView, { onBack: noop }))).toContain('分析完成後才能開啟')
    expect(html(React.createElement(StudioLoadingView))).toContain('role="status"')
  })
})
