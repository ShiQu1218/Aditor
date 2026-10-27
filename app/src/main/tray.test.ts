import { describe, expect, it, vi } from 'vitest'
import { basename } from 'path'
import type { Menu, MenuItemConstructorOptions } from 'electron'
import { IDLE_RECORDING_STATUS, type RecordingStatus } from '../shared/recording'
import { createRecordingTray } from './tray'

vi.mock('electron', () => ({ Tray: vi.fn(), Menu: { buildFromTemplate: vi.fn() } }))

function setup(phase: RecordingStatus['phase'] = 'idle') {
  let status: RecordingStatus = { ...IDLE_RECORDING_STATUS, phase }
  let listener!: (status: RecordingStatus) => void
  let items: MenuItemConstructorOptions[] = []
  const unsubscribe = vi.fn()
  const service = {
    start: vi.fn(), stop: vi.fn(async () => {}), startManual: vi.fn(async () => true), stopManual: vi.fn(async () => {}),
    setPaused: vi.fn(), status: () => status, capabilities: vi.fn(async () => null), onFinalized: vi.fn(() => vi.fn()),
    onStatus: vi.fn((fn: typeof listener) => { listener = fn; return unsubscribe })
  }
  const handle = { setImage: vi.fn(), setToolTip: vi.fn(), setContextMenu: vi.fn(), on: vi.fn(), destroy: vi.fn() }
  const openWindow = vi.fn(), quit = vi.fn(), notifyError = vi.fn()
  const tray = createRecordingTray({ service, iconDir: 'icons', openWindow, quit, notifyError }, {
    createTray: () => handle,
    buildMenu: (template) => { items = template; return {} as Menu }
  })
  if (!tray) throw new Error('Test tray failed to initialize')
  return {
    service, handle, openWindow, quit, notifyError, tray, unsubscribe,
    items: () => items,
    update: (patch: Partial<RecordingStatus>) => { status = { ...status, ...patch }; listener(status) },
    click: async (label: string) => {
      const action = items.find((item) => item.label === label)?.click as (() => void) | undefined
      expect(action).toBeTypeOf('function')
      action!()
      await vi.waitFor(() => expect(service.startManual.mock.calls.length + service.stopManual.mock.calls.length +
        service.setPaused.mock.calls.length + openWindow.mock.calls.length + quit.mock.calls.length).toBeGreaterThan(0))
      await Promise.resolve()
    }
  }
}

describe('recording tray', () => {
  it('returns null when the initial icon is missing so startup can continue without a tray', () => {
    const s = setup()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const buildMenu = vi.fn()
    try {
      expect(createRecordingTray({ service: s.service, iconDir: 'missing-icons',
        openWindow: s.openWindow, quit: s.quit, notifyError: s.notifyError }, {
        createTray: () => { throw new Error('Failed to load image from path') }, buildMenu
      })).toBeNull()
      expect(s.service.onStatus).toHaveBeenCalledOnce()
      expect(buildMenu).not.toHaveBeenCalled()
      expect(error).toHaveBeenCalledOnce()
    } finally {
      error.mockRestore()
      s.tray.destroy()
    }
  })

  it.each([
    ['idle', 'idle', '待命', '開始錄影', true],
    ['starting', 'idle', '正在啟動錄影', '停止錄影', true],
    ['recording', 'recording', '錄影中', '停止錄影', true],
    ['finalizing', 'idle', '正在儲存錄影', '開始錄影', false],
    ['error', 'error', '錄影錯誤', '開始錄影', true]
  ] as const)('maps %s to its icon, tooltip and action', (phase, icon, label, action, enabled) => {
    const s = setup(phase)
    expect(basename(s.handle.setImage.mock.calls[0][0])).toBe(`tray-${icon}.png`)
    expect(s.handle.setToolTip).toHaveBeenCalledWith(`Aditor — ${label}`)
    expect(s.items().find((item) => item.label === action)?.enabled).toBe(enabled)
    s.tray.destroy()
  })

  it('keeps the open context menu when only stats change (a replaced menu swallows clicks)', () => {
    const s = setup('recording')
    const menus = s.handle.setContextMenu.mock.calls.length
    const images = s.handle.setImage.mock.calls.length
    s.update({ kills: 3, droppedFrames: 2, durationSec: 120, diskFreeBytes: 1e12 })
    s.update({ matchIndex: 2 })
    expect(s.handle.setContextMenu.mock.calls.length).toBe(menus)
    expect(s.handle.setImage.mock.calls.length).toBe(images)
    s.update({ paused: true })
    expect(s.handle.setContextMenu.mock.calls.length).toBe(menus + 1)
    s.tray.destroy()
  })

  it('starts, stops and pauses through the service and reflects pushed state', async () => {
    const s = setup()
    await s.click('開始錄影')
    expect(s.service.startManual).toHaveBeenCalledOnce()
    s.update({ phase: 'recording' })
    await s.click('停止錄影')
    expect(s.service.stopManual).toHaveBeenCalledOnce()
    await s.click('暫停自動錄影')
    expect(s.service.setPaused).toHaveBeenCalledWith(true)
    s.update({ paused: true })
    expect(s.items().find((item) => item.type === 'checkbox')?.checked).toBe(true)
    await s.click('暫停自動錄影')
    expect(s.service.setPaused).toHaveBeenLastCalledWith(false)
    s.tray.destroy()
  })

  it('opens on double click or the menu and quits only through the exit action', async () => {
    const s = setup()
    expect(s.handle.on).toHaveBeenCalledWith('double-click', s.openWindow)
    await s.click('打開 Aditor')
    expect(s.openWindow).toHaveBeenCalledOnce()
    expect(s.quit).not.toHaveBeenCalled()
    await s.click('結束')
    expect(s.quit).toHaveBeenCalledOnce()
    s.tray.destroy()
  })

  it('reports an unavailable game and rejected service actions', async () => {
    const s = setup()
    s.service.startManual.mockResolvedValueOnce(false)
    await s.click('開始錄影')
    await vi.waitFor(() => expect(s.notifyError).toHaveBeenCalledOnce())
    s.update({ phase: 'recording' })
    s.service.stopManual.mockRejectedValueOnce(new Error('stop failed'))
    await s.click('停止錄影')
    await vi.waitFor(() => expect(s.notifyError).toHaveBeenLastCalledWith(expect.stringContaining('stop failed')))
    s.tray.destroy()
  })

  it('unsubscribes and destroys once; late state updates do not touch the tray', () => {
    const s = setup()
    s.tray.destroy()
    s.tray.destroy()
    s.update({ phase: 'recording' })
    expect(s.unsubscribe).toHaveBeenCalledOnce()
    expect(s.handle.destroy).toHaveBeenCalledOnce()
    expect(s.handle.setImage).toHaveBeenCalledOnce()
  })

  it('does not throw when the icon file fails to load; updates notifications and menu normally and logs only once', () => {
    const t = setup()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    t.handle.setImage.mockImplementation(() => { throw new Error('Failed to load image from path') })
    expect(() => t.update({ phase: 'error' })).not.toThrow()
    expect(t.handle.setToolTip).toHaveBeenLastCalledWith('Aditor — 錄影錯誤')
    expect(() => t.update({ phase: 'error', paused: true })).not.toThrow()
    expect(error).toHaveBeenCalledTimes(1)
    error.mockRestore()
  })
})
