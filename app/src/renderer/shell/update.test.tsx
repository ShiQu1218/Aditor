// @vitest-environment jsdom
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { UpdateStatus } from '../../shared/update'
import { shellI18n } from '../i18n'
import { Rail } from './Rail'
import { updateNoticeFor } from './updateNotice'
import { useUpdateNotice, useUpdateStatus } from './useUpdateStatus'
import { cleanupMounted, click, installDomShims, mount } from '../../../test/dom'

let previousApi: Window['api']
beforeEach(() => { installDomShims(); previousApi = window.api })
afterEach(() => { cleanupMounted(); window.api = previousApi; vi.restoreAllMocks() })

interface UpdateRig {
  listeners: Set<(status: UpdateStatus) => void>
  emit: (status: UpdateStatus) => void
  resolve: (status: UpdateStatus) => Promise<void>
}

function updateRig(): UpdateRig {
  const listeners = new Set<(status: UpdateStatus) => void>()
  let resolveSnapshot: ((status: UpdateStatus) => void) | null = null
  window.api = {
    ...window.api,
    update: {
      getStatus: vi.fn(() => new Promise<UpdateStatus>((resolve) => { resolveSnapshot = resolve })),
      onStatus: (callback: (status: UpdateStatus) => void) => {
        listeners.add(callback)
        return () => { listeners.delete(callback) }
      }
    }
  }
  return {
    listeners,
    emit: (status) => { act(() => { listeners.forEach((callback) => callback(status)) }) },
    resolve: async (status) => {
      await act(async () => {
        resolveSnapshot?.(status)
        await Promise.resolve()
      })
    }
  }
}

function StatusProbe(): JSX.Element {
  const status = useUpdateStatus()
  return <span>{`${status.state}:${status.version ?? ''}`}</span>
}

function NoticeProbe(): JSX.Element {
  const notice = useUpdateNotice()
  return <span>{notice === null ? 'none' : notice.kind}</span>
}

describe('useUpdateStatus', () => {
  test('a push that arrives before getStatus resolves is not overwritten by the older snapshot', async () => {
    const rig = updateRig()
    mount(<StatusProbe />)
    rig.emit({ state: 'downloading', version: '1.2.3' })
    expect(document.body.textContent).toBe('downloading:1.2.3')
    await rig.resolve({ state: 'idle' })
    expect(document.body.textContent).toBe('downloading:1.2.3')
  })

  test('the snapshot is applied when no push arrived first', async () => {
    const rig = updateRig()
    mount(<StatusProbe />)
    await rig.resolve({ state: 'downloaded', version: '2.0.0' })
    expect(document.body.textContent).toBe('downloaded:2.0.0')
  })

  test('unmount unsubscribes from status pushes', () => {
    const rig = updateRig()
    const view = mount(<StatusProbe />)
    expect(rig.listeners.size).toBe(1)
    view.unmount()
    expect(rig.listeners.size).toBe(0)
  })

  test('stays idle without window.api.update', () => {
    window.api = {} as Window['api']
    mount(<StatusProbe />)
    expect(document.body.textContent).toBe('idle:')
  })
})

describe('useUpdateNotice', () => {
  test('an available update with a version shows the available notice', () => {
    const rig = updateRig()
    mount(<NoticeProbe />)
    rig.emit({ state: 'available', version: '1.2.3' })
    expect(document.body.textContent).toBe('available')
  })

  test('keeps a failed notice after a newer version was seen', () => {
    const rig = updateRig()
    mount(<NoticeProbe />)
    rig.emit({ state: 'downloading', version: '1.2.3' })
    expect(document.body.textContent).toBe('available')
    rig.emit({ state: 'error', error: 'network' })
    expect(document.body.textContent).toBe('failed')
  })

  test('a failed check with no prior version stays hidden', () => {
    const rig = updateRig()
    mount(<NoticeProbe />)
    rig.emit({ state: 'error', error: 'network' })
    expect(document.body.textContent).toBe('none')
  })
})

describe('updateNoticeFor', () => {
  test('available, downloading, or downloaded with a version is available', () => {
    expect(updateNoticeFor({ state: 'available', version: '1.2.3' }, null)).toEqual({ kind: 'available', version: '1.2.3' })
    expect(updateNoticeFor({ state: 'downloading', version: '1.2.3' }, null)).toEqual({ kind: 'available', version: '1.2.3' })
    expect(updateNoticeFor({ state: 'downloaded', version: '1.2.3' }, null)).toEqual({ kind: 'available', version: '1.2.3' })
  })

  test('error after a seen version is failed', () => {
    expect(updateNoticeFor({ state: 'error', error: 'network' }, '1.2.3')).toEqual({ kind: 'failed' })
  })

  test('error with no prior version is null', () => {
    expect(updateNoticeFor({ state: 'error', error: 'network' }, null)).toBeNull()
  })
})

describe('Rail update button', () => {
  const t = shellI18n.rail

  test('no update button when the notice is null', () => {
    mount(<Rail active="library" projectCount={0} onNavigate={() => undefined} updateNotice={null} />)
    expect(document.querySelector('.update-dot')).toBeNull()
    expect(document.querySelector(`[aria-label="${t.updateFailed}"]`)).toBeNull()
  })

  test('available notice shows the version in its label and opens Settings', () => {
    const onNavigate = vi.fn()
    mount(<Rail active="library" projectCount={0} onNavigate={onNavigate} updateNotice={{ kind: 'available', version: '1.4.0' }} />)
    const label = t.updateAvailable.replace('{version}', '1.4.0')
    const trigger = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)
    expect(trigger).not.toBeNull()
    expect(trigger!.getAttribute('data-tip')).toBe(label)
    expect(trigger!.querySelector('.update-dot')).not.toBeNull()
    expect(trigger!.querySelector('.update-dot.failed')).toBeNull()
    expect(trigger!.querySelector('.rec-dot')).toBeNull()
    click(trigger!)
    expect(onNavigate).toHaveBeenCalledWith('settings')
  })

  test('failed notice uses the failed label and dot, and opens Settings', () => {
    const onNavigate = vi.fn()
    mount(<Rail active="library" projectCount={0} onNavigate={onNavigate} updateNotice={{ kind: 'failed' }} />)
    const trigger = document.querySelector<HTMLButtonElement>(`[aria-label="${t.updateFailed}"]`)
    expect(trigger).not.toBeNull()
    expect(trigger!.getAttribute('data-tip')).toBe(t.updateFailed)
    expect(trigger!.querySelector('.update-dot.failed')).not.toBeNull()
    click(trigger!)
    expect(onNavigate).toHaveBeenCalledWith('settings')
  })
})
