// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanupMounted, mount } from '../../../test/dom'
import { createProject } from '../editor/project'
import { createMode } from './mode'
import { useStudioSourceEdits } from './useStudioSourceEdits'
import type { Clip } from '../../shared/types'

afterEach(cleanupMounted)

test.each(['remove', 'accept', 'blade', 'skip', 'all'] as const)('%s Toast Undo cannot edit a different project or an unmounted studio', (operation) => {
  const clip: Clip = { id: 'clip-a', start: 1, end: 3, origin: 'ai', event_ids: [], status: 'suggested' }
  const projectRef = { current: createProject('A', operation === 'remove'
    ? [{ id: 'item-a', source: 'D:/a.mp4', start: 1, end: 3, clipId: clip.id }] : []) }
  const mountedRef = { current: true }
  const apply = vi.fn((next) => { projectRef.current = next })
  const dispatch = vi.fn()
  const toast = vi.fn()
  const mode = createMode('D:/a.mp4')
  const options: Parameters<typeof useStudioSourceEdits>[0] = {
    videoPath: 'D:/a.mp4', videoRef: { current: null }, mode, modeRef: { current: mode }, dispatchMode: vi.fn(),
    dispatch, apply, toast, projectRef, projectId: 'project-a', mountedRef, previewRef: { current: { item: null } },
    currentTime: 1, shownClips: [clip], activeClipId: clip.id, setActiveClipId: vi.fn(), setSelProjId: vi.fn(),
    bladeMode: false, setBladeMode: vi.fn(), backToSource: vi.fn(), seekTo: vi.fn()
  }
  let edits!: ReturnType<typeof useStudioSourceEdits>
  function Harness() { edits = useStudioSourceEdits(options); return null }
  const mounted = mount(<Harness />)
  act(() => {
    if (operation === 'remove') edits.removeFromProject(clip)
    else if (operation === 'accept') edits.acceptClip(clip)
    else if (operation === 'blade') edits.createBladeClip(1, 3)
    else if (operation === 'skip') edits.skipClip(clip)
    else edits.addAllSuggestions()
  })
  const undo = toast.mock.calls.at(-1)![0].action.run
  projectRef.current = createProject('B')
  options.projectId = 'project-b'
  act(() => mounted.root.render(<Harness />))
  apply.mockClear(); dispatch.mockClear()
  act(undo)
  expect(apply).not.toHaveBeenCalled()
  expect(dispatch).not.toHaveBeenCalled()
  // Going back to A still cannot run the old action after its studio was removed.
  options.projectId = 'project-a'
  act(() => mounted.root.render(<Harness />))
  mountedRef.current = false
  act(undo)
  expect(apply).not.toHaveBeenCalled()
  expect(dispatch).not.toHaveBeenCalled()
})
