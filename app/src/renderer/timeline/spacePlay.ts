/**
 * 時間軸的空白鍵仲裁（spec §3.2.2 互動模型）：
 * 空白鍵同時是播放／暫停；只有「按住 >200 ms 且拖曳」才視為平移，且不觸發播放。
 * 輕按（放開時未平移）＝播放，於放開時觸發。
 */

/** 按住超過此毫秒數後才有資格成為平移 */
export const PAN_HOLD_MS = 200

export interface SpaceArbiter {
  /** 空白鍵按下中、尚未決定 */
  pending: boolean
  startedAt: number
  /** 本次手勢已成為平移 */
  panned: boolean
}

export const idleArbiter: SpaceArbiter = { pending: false, startedAt: 0, panned: false }

export type SpaceArbEvent =
  | { type: 'keydown'; now: number }
  | { type: 'keyup'; now: number }
  | { type: 'pointerdown'; now: number }
  | { type: 'cancel' }

export interface SpaceArbResult {
  state: SpaceArbiter
  /** 放開時觸發播放 */
  play: boolean
  /** 本次按下視為平移 */
  pan: boolean
}

export function spaceArbiter(s: SpaceArbiter, ev: SpaceArbEvent): SpaceArbResult {
  switch (ev.type) {
    case 'keydown':
      // 已在按住中（key repeat）不重置計時
      if (s.pending) return { state: s, play: false, pan: false }
      return { state: { pending: true, startedAt: ev.now, panned: false }, play: false, pan: false }
    case 'pointerdown':
      if (!s.pending) return { state: s, play: false, pan: false }
      if (ev.now - s.startedAt >= PAN_HOLD_MS) {
        return { state: { ...s, pending: false, panned: true }, play: false, pan: true }
      }
      // 還沒到達門檻就拖曳：不是平移，也不播放（避免誤觸）
      return { state: { ...s, pending: false }, play: false, pan: false }
    case 'keyup':
      if (!s.pending) return { state: idleArbiter, play: false, pan: false }
      return { state: { pending: false, startedAt: 0, panned: s.panned }, play: !s.panned, pan: false }
    case 'cancel':
      return { state: idleArbiter, play: false, pan: false }
  }
}
