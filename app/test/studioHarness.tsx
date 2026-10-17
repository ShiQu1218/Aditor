// 工作室元件測試用：以假 api 掛載整個 StudioScreen（preloadedDoc＋ProjectProvider 還原的專案）。
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
  /** 覆寫文件（預設 buildLongDoc：約 300 事件、8 個示範片段） */
  doc?: (d: CacheDoc) => CacheDoc
  clips?: Clip[]
  /** 啟動時由 ProjectProvider 還原的專案片段 */
  items?: ProjectItem[]
  api?: FakeApiOptions
  onBack?: () => void
  onOpenVideo?: React.ComponentProps<typeof StudioScreen>['onOpenVideo']
}

export interface StudioMount {
  m: Mounted
  fake: FakeApi
  doc: CacheDoc
  restore: () => void
}

/** 由事件均勻取 n 段 AI 片段（確定性）。 */
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
  // 引擎 autoclip 的假回應：自動放置建議（planSuggestions）會用它產生「待確認」的 AI 片段
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
      <StudioScreen videoPath={STUDIO_VIDEO} onBack={opts.onBack ?? (() => undefined)} onOpenVideo={opts.onOpenVideo ?? (() => undefined)} preloadedDoc={doc} />
    </Providers>
  )
  await flush(20)
  await flush(20)
  return { m, fake, doc, restore }
}
