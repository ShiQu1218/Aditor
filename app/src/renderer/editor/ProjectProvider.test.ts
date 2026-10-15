import React from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ProjectProvider, useProject } from './ProjectProvider'

const g = globalThis as unknown as { window?: unknown }
let prev: unknown
const api = {
  projects: { save: vi.fn(), load: vi.fn(), flushSync: vi.fn(), onFlushRequest: vi.fn(), flushDone: vi.fn() },
  settings: { get: vi.fn(), set: vi.fn(), onChanged: vi.fn() },
  library: { fileExists: vi.fn() }
}

beforeEach(() => {
  prev = g.window
  g.window = { api, addEventListener: vi.fn(), removeEventListener: vi.fn() }
})
afterEach(() => {
  g.window = prev
  vi.clearAllMocks()
})

function Probe(): React.ReactElement {
  const p = useProject()
  return React.createElement('div', null, `${p.project.name}|${p.items.length}|${p.saveState}|${String(p.canUndo)}`)
}

describe('ProjectProvider SSR smoke', () => {
  test('renders the initial empty project, state saved, nothing persisted or fetched during render', () => {
    const html = renderToString(React.createElement(ProjectProvider, null, React.createElement(Probe)))
    expect(html).toContain('我的精華專案|0|saved|false')
    expect(api.projects.save).not.toHaveBeenCalled()
    expect(api.projects.flushSync).not.toHaveBeenCalled()
    expect(api.settings.set).not.toHaveBeenCalled()
  })

  test('works without window.api (no throw)', () => {
    g.window = { addEventListener: vi.fn(), removeEventListener: vi.fn() }
    expect(() => renderToString(React.createElement(ProjectProvider, null, React.createElement(Probe)))).not.toThrow()
  })
})
