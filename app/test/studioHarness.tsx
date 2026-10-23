// Studio component-test helper: mount the full StudioScreen with a fake API (preloadedDoc plus a project restored by ProjectProvider).
import React from 'react'
import { StudioScreen } from '../src/renderer/studio/StudioScreen'
import { buildLongDoc } from '../src/renderer/dev/longFixture'
import { createProject, type ProjectItem } from '../src/renderer/editor/project'
import type { CacheDoc, Clip } from '../src/shared/types'
import { createFakeApi, installFakeApi, type FakeApi, type FakeApiOptions } from './fakeApi'
import { Providers } from './harness'
import { flush, installDomShims, mount, type Mounted } from './dom'

export const STUDIO_VIDEO = 'fixture://long'

export interface StudioFixtureOptions {
  /** Override the document (defaults to buildLongDoc: about 300 events and 8 sample clips). */
  doc?: (d: CacheDoc) => CacheDoc
  clips?: Clip[]
  /** Project clips restored by ProjectProvider at startup. */
  items?: ProjectItem[]
  api?: FakeApiOptions
  onBack?: () => void
  onVideoRemoved?: (path: string) => void
  onOpenVideo?: React.ComponentProps<typeof StudioScreen>['onOpenVideo']
}

export interface StudioMount {
  m: Mounted
  fake: FakeApi
  doc: CacheDoc
  restore: () => void
}

/** Select n AI clips evenly from the events (deterministically). */
export function makeAiClips(doc: CacheDoc, n: number): Clip[] {
  const evs = doc.events.filter((e) => !e.deleted)
  const step = Math.max(1, Math.floor(evs.length / (n + 1)))
  return Array.from({ length: n }, (_, k): Clip => {
    const e = evs[(k + 1) * step]
    return { id: `ai_${k}`, start: Math.max(0, e.t - 8), end: e.t + 4, origin: 'ai', event_ids: [e.id] }
  })
}

export async function mountStudio(opts: StudioFixtureOptions = {}): Promise<StudioMount> {
  installDomShims({ width: 1366, height: 768 })
  let doc = { ...buildLongDoc(STUDIO_VIDEO), clips: [] as Clip[] }
  if (opts.doc) doc = opts.doc(doc)
  // Fake engine autoclip response: automatic suggestion placement (planSuggestions) uses it to create pending AI clips.
  const ai: Clip[] = opts.clips ?? makeAiClips(doc, 6)
  const project = { ...createProject('測試專案'), items: opts.items ?? [] }
  const fake = createFakeApi({
    ...opts.api,
    settings: { lastProjectId: 'p_test', ...opts.api?.settings },
    overrides: {
      projects: { load: async () => project },
      engine: { autoclip: async () => ({ clips: ai }) },
      ...opts.api?.overrides
    }
  })
  const restore = installFakeApi(fake)
  const m = mount(
    <Providers active="studio">
      <StudioScreen videoPath={STUDIO_VIDEO} onBack={opts.onBack ?? (() => undefined)} onVideoRemoved={opts.onVideoRemoved} onOpenVideo={opts.onOpenVideo ?? (() => undefined)} preloadedDoc={doc} />
    </Providers>
  )
  await flush(20)
  await flush(20)
  return { m, fake, doc, restore }
}
