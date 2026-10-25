import type { CacheDoc, EventType } from '../../shared/types'
import type { PlayabilityResult } from '../media/playability'
import type { ViewerState } from '../viewer/state'

export interface ProjectPlaybackRequest {
  playItemId: string
  speed: number
}

export const DEFAULT_FILTER = new Set<EventType>(['knock', 'assist_knock', 'assist_elim', 'elim', 'squad_wipe', 'kill', 'death', 'multikill', 'ace'])
export const DEFAULT_PLAYABILITY: PlayabilityResult = { supported: true, smooth: true, powerEfficient: true }

export function baseName(p: string): string {
  return p.split(/[/\\]/).pop() ?? p
}

/** Normalize a path when checking whether a clip belongs to the currently open video. */
export function normPath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

export function initialDoc(videoPath: string): CacheDoc {
  return {
    version: 1,
    video: {
      path: videoPath,
      size: 0,
      mtime: 0,
      duration: 100,
      width: 1920,
      height: 1080,
      codec: 'h264',
      start_time: 0
    },
    analysis: {
      status: 'done',
      progress_t: 0,
      engine_version: '0.1.0',
      templates_version: 'icons@1',
      h_scale: 1.0
    },
    events: [],
    spectating: [],
    clips: [],
    keyframes: [],
    cache_path: ''
  }
}

export function initViewerState(init: { videoPath: string; doc?: CacheDoc }): ViewerState {
  return {
    doc: init.doc ?? initialDoc(init.videoPath),
    filter: new Set(DEFAULT_FILTER),
    clips: [],
    dirty: false
  }
}
