import { describe, expect, test } from 'vitest'
import { idleArbiter, PAN_HOLD_MS, spaceArbiter } from './spacePlay'

describe('空白鍵仲裁（播放 vs 平移）', () => {
  test('輕按（未拖曳）放開時觸發播放', () => {
    let s = spaceArbiter(idleArbiter, { type: 'keydown', now: 0 }).state
    const up = spaceArbiter(s, { type: 'keyup', now: 80 })
    expect(up.play).toBe(true)
    expect(up.state.pending).toBe(false)
  })

  test('按住 300 ms 且拖曳＝平移、放開不播放', () => {
    const down = spaceArbiter(idleArbiter, { type: 'keydown', now: 0 })
    expect(down.play).toBe(false)
    const drag = spaceArbiter(down.state, { type: 'pointerdown', now: 300 })
    expect(drag.pan).toBe(true)
    const up = spaceArbiter(drag.state, { type: 'keyup', now: 350 })
    expect(up.play).toBe(false)
  })

  test('按住很久但沒有拖曳：放開仍播放', () => {
    const down = spaceArbiter(idleArbiter, { type: 'keydown', now: 0 })
    const up = spaceArbiter(down.state, { type: 'keyup', now: 1000 })
    expect(up.play).toBe(true)
  })

  test('未達 200 ms 門檻就拖曳：不平移也不播放', () => {
    const down = spaceArbiter(idleArbiter, { type: 'keydown', now: 0 })
    const drag = spaceArbiter(down.state, { type: 'pointerdown', now: PAN_HOLD_MS - 1 })
    expect(drag.pan).toBe(false)
    const up = spaceArbiter(drag.state, { type: 'keyup', now: PAN_HOLD_MS + 10 })
    expect(up.play).toBe(false)
  })

  test('重複 keydown（按住不放）不重置計時', () => {
    const down = spaceArbiter(idleArbiter, { type: 'keydown', now: 0 })
    const repeat = spaceArbiter(down.state, { type: 'keydown', now: 150 })
    const drag = spaceArbiter(repeat.state, { type: 'pointerdown', now: 260 })
    expect(drag.pan).toBe(true)
  })

  test('未按下時放開或失焦：不動作', () => {
    expect(spaceArbiter(idleArbiter, { type: 'keyup', now: 10 }).play).toBe(false)
    const down = spaceArbiter(idleArbiter, { type: 'keydown', now: 0 })
    const cancel = spaceArbiter(down.state, { type: 'cancel' })
    expect(cancel.state).toEqual(idleArbiter)
  })
})
