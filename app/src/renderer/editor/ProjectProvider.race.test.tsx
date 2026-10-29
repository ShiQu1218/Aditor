// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanupMounted, flush, mount } from '../../../test/dom'
import { createFakeApi, installFakeApi } from '../../../test/fakeApi'
import { createProject, type Project } from './project'
import { ProjectProvider, useProject, type ProjectContextValue } from './ProjectProvider'

let restore: (() => void) | undefined
afterEach(() => { cleanupMounted(); restore?.(); restore = undefined })

test.each(['edit', 'laterOpen'] as const)('a project load cannot replace a newer %s action', async (action) => {
  let finishFirst!: (project: Project) => void
  let finishSecond!: (project: Project) => void
  const firstLoad = new Promise<Project>((resolve) => { finishFirst = resolve })
  const secondLoad = new Promise<Project>((resolve) => { finishSecond = resolve })
  const fake = createFakeApi({ overrides: { projects: { load: vi.fn((id) => id === 'first' ? firstLoad : secondLoad) } } })
  restore = installFakeApi(fake)
  let current!: ProjectContextValue
  function Probe() { current = useProject(); return null }
  mount(<ProjectProvider><Probe /></ProjectProvider>)
  await flush()
  let first!: Promise<boolean>
  let second!: Promise<boolean>
  act(() => { first = current.openProject('first') })
  if (action === 'edit') act(() => current.apply({ ...current.project, name: 'New edit' }))
  else act(() => { second = current.openProject('second') })
  const expected = current.project
  let firstOpened!: boolean
  await act(async () => { finishFirst(createProject('First')); firstOpened = await first })
  expect(firstOpened).toBe(false)
  expect(current.project).toBe(expected)
  if (action === 'laterOpen') {
    let secondOpened!: boolean
    await act(async () => { finishSecond(createProject('Second')); secondOpened = await second })
    expect(secondOpened).toBe(true)
    expect(current.project.id).toBe('second')
  }
})
