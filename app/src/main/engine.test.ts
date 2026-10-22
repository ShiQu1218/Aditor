import { describe, it, expect, afterEach, vi } from 'vitest'
import { EngineClient, EngineError } from './engine'
import path from 'path'

const FAKE_ENGINE = path.resolve(__dirname, '../../test/fake-engine.mjs')

describe('EngineClient', () => {
  let client: EngineClient | null = null

  afterEach(async () => {
    if (client) {
      await client.stop()
      client = null
    }
  })

  it('start resolves engine version', async () => {
    client = new EngineClient({
      command: process.execPath,
      args: [FAKE_ENGINE]
    })
    const res = await client.start()
    expect(res.engineVersion).toBe('0.1.0')
  })

  it('lowers the engine process priority after spawn', async () => {
    const setPriority = vi.fn()
    client = new EngineClient({ command: process.execPath, args: [FAKE_ENGINE], setPriority })
    await client.start()
    expect(setPriority).toHaveBeenCalledWith(expect.any(Number))
  })

  it('reports a priority failure as a diagnostic without failing start', async () => {
    const onDiagnostic = vi.fn()
    const setPriority = vi.fn(() => { throw new Error('Access denied') })
    client = new EngineClient({ command: process.execPath, args: [FAKE_ENGINE], setPriority, onDiagnostic })
    const res = await client.start()
    expect(res.engineVersion).toBe('0.1.0')
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ component: 'python-engine', code: 'engine_priority' }))
  })

  it('forwards child diagnostics without affecting request rejection or normal shutdown', async () => {
    const onDiagnostic = vi.fn(() => { throw new Error('Monitoring unavailable') })
    client = new EngineClient({ command: process.execPath, args: [FAKE_ENGINE], onDiagnostic })
    await client.start()
    await expect(client.request('error_test', {}).promise).rejects.toMatchObject({ code: 'probe_failed' })
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ component: 'python-engine', code: 'probe_failed' }))
    await client.stop()
    expect(onDiagnostic).toHaveBeenCalledTimes(1)
  })

  it('request resolves result and streams progress', async () => {
    client = new EngineClient({
      command: process.execPath,
      args: [FAKE_ENGINE]
    })
    await client.start()

    const progress: Array<{ t: number; duration: number }> = []
    const req = client.request<{ cache_path: string; events: unknown[] }>(
      'analyze',
      { path: 'video.mp4' },
      (p) => progress.push(p)
    )

    expect(req.id).toBeTruthy()
    const result = await req.promise
    expect(result.cache_path).toBe('/path/to/cache.json')
    expect(progress).toEqual([
      { t: 30, duration: 120 },
      { t: 60, duration: 120 }
    ])
  })

  it('error maps to EngineError with code', async () => {
    client = new EngineClient({
      command: process.execPath,
      args: [FAKE_ENGINE]
    })
    await client.start()

    const req = client.request('error_test', {})
    await expect(req.promise).rejects.toThrow(EngineError)
    try {
      await req.promise
    } catch (err) {
      const e = err as EngineError
      expect(e.code).toBe('probe_failed')
      expect(e.message).toBe('test error')
    }
  })

  it('cancel sends cancel cmd with target id', async () => {
    client = new EngineClient({
      command: process.execPath,
      args: [FAKE_ENGINE]
    })
    await client.start()

    const req = client.request('probe', { path: 'a.mp4' })
    client.cancel(req.id)
    const result = await req.promise
    expect(result).toBeDefined()
  })

  it('engine crash rejects pending and restarts', async () => {
    client = new EngineClient({
      command: process.execPath,
      args: [FAKE_ENGINE]
    })
    await client.start()

    let crashed = false
    client.on('crash', () => {
      crashed = true
    })

    const req = client.request('crash', {})
    await expect(req.promise).rejects.toThrow(EngineError)
    try {
      await req.promise
    } catch (err) {
      const e = err as EngineError
      expect(e.code).toBe('engine_crashed')
    }
    expect(crashed).toBe(true)

    // Verify it automatically restarted and can accept new requests
    const nextReq = client.request<{ path: string }>('probe', { path: 'b.mp4' })
    const res = await nextReq.promise
    expect(res.path).toBe('b.mp4')
  })

  it('stops restarting after 3 crashes in 60s', async () => {
    client = new EngineClient({
      command: process.execPath,
      args: [FAKE_ENGINE]
    })
    await client.start()

    let crashCount = 0
    client.on('crash', () => {
      crashCount++
    })

    // Crash 1
    await expect(client.request('crash', {}).promise).rejects.toThrow()
    // Crash 2
    await expect(client.request('crash', {}).promise).rejects.toThrow()
    // Crash 3
    await expect(client.request('crash', {}).promise).rejects.toThrow()

    // 4th request should fail immediately without restarting
    await expect(client.request('probe', { path: 'c.mp4' }).promise).rejects.toThrow(EngineError)
    expect(crashCount).toBe(3)
  })

  it('handles chunked and multi-line stdout', async () => {
    client = new EngineClient({
      command: process.execPath,
      args: [FAKE_ENGINE],
      env: { FAKE_ENGINE_MODE: 'chunked_ready' }
    })
    const startRes = await client.start()
    expect(startRes.engineVersion).toBe('0.1.0')

    // Chunked result
    const chunkedReq = client.request<{ ok: boolean }>('chunked_result', {})
    const chunkedRes = await chunkedReq.promise
    expect(chunkedRes.ok).toBe(true)

    // Multi-line in single chunk
    const prog: Array<{ t: number }> = []
    const multiReq = client.request<{ multi: boolean }>('multiline_result', {}, (p) => prog.push(p))
    const multiRes = await multiReq.promise
    expect(multiRes.multi).toBe(true)
    expect(prog).toEqual([{ t: 10, duration: 100 }])
  })
})
