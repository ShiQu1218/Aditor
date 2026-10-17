import React from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { createProject } from '../editor/project'
import { ProjectTrack, ProjectTrackProps } from './ProjectTrack'

const noop = (): void => undefined

function props(over: Partial<ProjectTrackProps> = {}): ProjectTrackProps {
  const project = createProject('P', [
    { id: 'a', source: 'C:/v/a.mp4', start: 0, end: 10 },
    { id: 'b', source: 'C:/v/b.mp4', start: 5, end: 25 }
  ])
  return {
    project,
    collapsed: false,
    onToggleCollapsed: noop,
    selectedId: 'a',
    onSelect: noop,
    currentId: null,
    progress: 0,
    labelOf: () => '精華片段',
    missingIds: new Set<string>(),
    saveState: 'saved',
    videoPath: 'C:/v/a.mp4',
    videoDuration: 100,
    onPlay: noop,
    onMissing: noop,
    onTrim: noop,
    onMove: noop,
    onRename: noop,
    onSplit: noop,
    onDuplicate: noop,
    onDelete: noop,
    onUndo: noop,
    onRedo: noop,
    canUndo: false,
    canRedo: false,
    onNewProject: noop,
    onAddExternalVideo: noop,
    onExport: noop,
    exportOpen: false,
    exportPercent: null,
    onAddFromSource: noop,
    onDialogOpenChange: noop,
    ...over
  }
}

const html = (p: ProjectTrackProps): string => renderToString(React.createElement(ProjectTrack, p))

describe('ProjectTrack markup', () => {
  test('items are role=listitem (not buttons) inside data-zone="proj"', () => {
    const out = html(props())
    expect(out).toContain('data-zone="proj"')
    expect(out.match(/role="listitem"/g)).toHaveLength(2)
    expect(out).not.toMatch(/<button[^>]*data-item-id/)
  })

  test('split button is labelled 分割; two sources shown', () => {
    const out = html(props())
    expect(out).toContain('aria-label="分割"')
    expect(out).toContain('來自 2 支影片')
  })

  test('missing items get the missing class and warning title; others do not', () => {
    const out = html(props({ missingIds: new Set(['b']) }))
    expect(out.match(/pclip[^"]*missing/g)).toHaveLength(1)
    expect(out).toContain('來源影片不存在')
  })

  test('collapsed adds the collapsed class', () => {
    expect(html(props({ collapsed: true }))).toContain('project-lane collapsed')
    expect(html(props())).not.toContain('collapsed')
  })
})
