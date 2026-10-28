import { describe, it, expect, afterEach, vi } from 'vitest'
import { EngineClient } from './engine'
import { engineCommand } from '../shared/paths'

describe('EngineClient with real Rust engine', () => {
  let client: EngineClient | null = null

  afterEach(async () => {
    if (client) {
      await client.stop()
      client = null
    }
  })

  it('forwards the native exception envelope on a reportable IPC failure', async () => {
    const onDiagnostic = vi.fn()
    client = new EngineClient({ ...engineCommand(false), onDiagnostic })
    await client.start()
    await expect(client.request('derive', { events: [], spectating: [], profile_dir: 'missing-real-test-profile' }).promise)
      .rejects.toMatchObject({ code: 'profile_error' })
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      component: 'rust-engine', code: 'profile_error', exception: { type: 'ProfileError', frames: [] }
    }))
  })

  it('connects to real engine and gets the engine version', async () => {
    const cmd = engineCommand(false)
    client = new EngineClient(cmd)
    const res = await client.start()
    expect(res.engineVersion).toBe('0.3.0')
  })
})
