// @vitest-environment jsdom
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { LibraryScreen } from './LibraryScreen'
import { createFakeApi, installFakeApi, type FakeApi } from '../../../test/fakeApi'
import { Providers } from '../../../test/harness'
import { cleanupMounted, flush, installDomShims, mount } from '../../../test/dom'
import { installGlobalDropGuard } from '../lib/dropGuard'

describe('library file drops', () => {
  let fake: FakeApi
  let restore: () => void
  let removeGuard: () => void
  let target: HTMLElement

  beforeEach(async () => {
    installDomShims()
    fake = createFakeApi()
    restore = installFakeApi(fake)
    removeGuard = installGlobalDropGuard()
    const { container } = mount(
      <Providers>
        <LibraryScreen onSelectVideo={() => undefined} onOpenSettings={() => undefined} />
      </Providers>
    )
    target = container.querySelector('.lib-empty')!
    await flush()
  })

  afterEach(() => {
    cleanupMounted()
    removeGuard()
    restore()
    vi.restoreAllMocks()
  })

  function dispatch(type: string, files: File[]): Event {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: { files } })
    act(() => target.dispatchEvent(event))
    return event
  }

  test('passes Files without the removed File.path property to preload and clears the overlay', () => {
    const files = [new File(['a'], '錄影 A.mp4'), new File(['b'], '錄影 B.mkv')]
    expect(files.every((file) => !('path' in file))).toBe(true)
    expect(dispatch('dragover', files).defaultPrevented).toBe(true)
    expect(document.querySelector('.drop-overlay')).not.toBeNull()

    expect(dispatch('drop', files).defaultPrevented).toBe(true)

    expect(fake.api.library.addDroppedFiles).toHaveBeenCalledTimes(1)
    expect(fake.api.library.addDroppedFiles).toHaveBeenCalledWith(files)
    expect(fake.api.library.add).not.toHaveBeenCalled()
    expect(document.querySelector('.drop-overlay')).toBeNull()
  })

  test('ignores drops without files and still prevents navigation', () => {
    expect(dispatch('drop', []).defaultPrevented).toBe(true)
    expect(fake.api.library.addDroppedFiles).not.toHaveBeenCalled()
    expect(fake.api.library.add).not.toHaveBeenCalled()
  })
})
