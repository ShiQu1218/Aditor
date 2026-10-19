import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { DEFAULT_RECORDING_SETTINGS } from '../shared/recording'
import { createRecordingNotifier } from './notify'

vi.mock('electron', () => ({ Notification: vi.fn() }))

afterEach(() => vi.restoreAllMocks())

function setup() {
  const settings = { ...DEFAULT_RECORDING_SETTINGS }
  const notice = Object.assign(new EventEmitter(), { show: vi.fn() })
  const create = vi.fn((_options: { title: string; body: string }) => notice)
  const supported = vi.fn(() => true)
  const notify = createRecordingNotifier(() => settings, { create, isSupported: supported })
  return { settings, notice, create, supported, notify }
}

describe('recording notifications', () => {
  it('always shows errors, disk warnings and finalized filenames', () => {
    const s = setup()
    s.notify('error', '錄影失敗')
    s.notify('diskWarn', '空間不足')
    s.notify('finalized', '已儲存：Apex_2026-10-18_12-00.mp4')
    expect(s.create.mock.calls.map(([options]) => options.body)).toEqual([
      '錄影失敗', '空間不足', '已儲存：Apex_2026-10-18_12-00.mp4'
    ])
    expect(s.notice.show).toHaveBeenCalledTimes(3)
  })

  it('reads the current match preference each time', () => {
    const s = setup()
    s.notify('matchStart', '對局開始')
    s.notify('matchEnd', '對局結束')
    expect(s.create).not.toHaveBeenCalled()
    s.settings.notifyMatch = true
    s.notify('matchStart', '對局開始')
    s.notify('matchEnd', '對局結束')
    expect(s.notice.show).toHaveBeenCalledTimes(2)
  })

  it('does not show unsupported notifications or propagate native failures', () => {
    const s = setup()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    s.supported.mockReturnValueOnce(false)
    s.notify('error', 'unsupported')
    expect(s.create).not.toHaveBeenCalled()
    s.notice.show.mockImplementationOnce(() => { throw new Error('native failure') })
    expect(() => s.notify('error', 'failed')).not.toThrow()
    expect(log).toHaveBeenCalledOnce()
    s.notify('error', 'async failure')
    expect(() => s.notice.emit('failed')).not.toThrow()
    expect(log).toHaveBeenCalled()
  })
})

it('倒數取消使用低優先靜音通知', () => {
  const s = setup()
  s.notify('matchCancel', '倒數後未開局')
  expect(s.create).toHaveBeenCalledWith({ title: 'Aditor', body: '倒數後未開局', silent: true, urgency: 'low' })
  expect(s.notice.show).toHaveBeenCalledOnce()
})
