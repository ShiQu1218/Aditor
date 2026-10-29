// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanupMounted, flush, mount } from '../../../test/dom'
import { createFakeApi, installFakeApi } from '../../../test/fakeApi'
import { buildLongDoc } from '../dev/longFixture'
import { useStudioDocument } from './useStudioDocument'
import type { ViewerState } from '../viewer/state'

let restore: (() => void) | undefined
afterEach(() => { cleanupMounted(); restore?.(); restore = undefined })

test.each(['entries', 'cache'] as const)('partial analysis rechecks completion received during an in-flight %s read', async (stage) => {
  const videoPath = 'D:/pending.mp4'
  const doc = buildLongDoc(videoPath)
  const partial = { ...doc, analysis: { ...doc.analysis, status: 'partial' as const } }
  const state: ViewerState = { doc: partial, clips: [], dirty: false, filter: new Set() }
  const dispatch = vi.fn()
  const entry = { path: videoPath, status: 'done' }
  let resolve!: (value: unknown) => void
  const delayed = new Promise((done) => { resolve = done })
  const getEntries = vi.fn(async () => [entry])
  const loadByVideo = vi.fn(async () => doc)
  if (stage === 'entries') getEntries.mockImplementationOnce(() => delayed as Promise<typeof entry[]>)
  else loadByVideo.mockImplementationOnce(() => delayed as Promise<typeof doc>)
  const fake = createFakeApi({ overrides: { library: { getEntries }, cache: { loadByVideo } } })
  restore = installFakeApi(fake)
  const options: Parameters<typeof useStudioDocument>[0] = {
    videoPath, reloadKey: 0, preloadedDoc: partial, allowUnanalyzed: true, loaded: true, state, stateRef: { current: state }, dispatch,
    exportCtl: { getState: () => ({ phase: 'settings' }) } as Parameters<typeof useStudioDocument>[0]['exportCtl'],
    toast: vi.fn(), setBlocked: vi.fn(), setLoadError: vi.fn(), setLoaded: vi.fn(), setAnalysisGen: vi.fn(),
    setPlayability: vi.fn(), setProxyPath: vi.fn(), setProxyState: vi.fn()
  }
  function Harness() { useStudioDocument(options); return null }
  mount(<Harness />)
  await flush()
  expect(getEntries).toHaveBeenCalledTimes(1)
  // The sole completion event arrives before the earlier pending snapshot is delivered.
  act(() => fake.emit('library:updated'))
  await act(async () => resolve(stage === 'entries' ? [{ ...entry, status: 'pending' }] : partial))
  await flush()
  expect(getEntries).toHaveBeenCalledTimes(2)
  expect(dispatch).toHaveBeenCalledWith({ type: 'analysisResult', doc })
})
