import { describe, it, expect, afterEach, vi } from 'vitest'
import { EngineClient, EngineError, redactHome } from './engine'
import path from 'path'
import os from 'os'
import fs from 'fs'

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

  it('cancels a queued request before a restarting engine is ready without sending it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-engine-cancel-'))
    const script = path.join(dir, 'engine.cjs')
    const trace = path.join(dir, 'trace')
    fs.writeFileSync(script, `const fs=require('fs');const rl=require('readline').createInterface({input:process.stdin});setTimeout(()=>console.log(JSON.stringify({type:'ready'})),100);rl.on('line',line=>{const r=JSON.parse(line);fs.appendFileSync(process.argv[2],r.cmd+'\\n');if(r.cmd==='crash')process.exit(1);console.log(JSON.stringify({type:'result',id:r.id,data:true}));});`)
    try {
      client = new EngineClient({ command: process.execPath, args: [script, trace] })
      await client.start()
      await expect(client.request('crash', {}).promise).rejects.toMatchObject({ code: 'engine_crashed' })
      const request = client.request('analyze', {})
      client.cancel(request.id)
      await expect(request.promise).rejects.toMatchObject({ code: 'cancelled' })
      await expect(client.request('probe', {}).promise).resolves.toBe(true)
      expect(fs.readFileSync(trace, 'utf8').trim().split('\n')).toEqual(['crash', 'probe'])
    } finally {
      await client?.stop()
      client = null
      fs.rmSync(dir, { recursive: true, force: true })
    }
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

  it('keeps UTF-8 characters intact when a character crosses stdout chunks', async () => {
    client = new EngineClient({ command: process.execPath, args: [FAKE_ENGINE] })
    await client.start()
    const result = await client.request<{ path: string }>('unicode_result', {}).promise
    expect(result.path).toBe('D:/影片/中文.mp4')
  })

  it('drops an incomplete line when the engine restarts', async () => {
    const marker = path.join(os.tmpdir(), `aditor-engine-partial-${Date.now()}-${Math.random()}.marker`)
    client = new EngineClient({
      command: process.execPath,
      args: [FAKE_ENGINE],
      env: { FAKE_ENGINE_PARTIAL_MARKER: marker }
    })
    try {
      await client.start()
      await expect(client.request('partial_unicode_crash', {}).promise).rejects.toMatchObject({ code: 'engine_crashed' })
      const result = await client.request<{ path: string }>('probe', { path: 'D:/重啟.mp4' }).promise
      expect(result.path).toBe('D:/重啟.mp4')
    } finally {
      fs.rmSync(marker, { force: true })
    }
  })

  describe('crash messages', () => {
    const READY = `setTimeout(()=>console.log(JSON.stringify({type:'ready'})),50);`
    const RL = `const rl=require('readline').createInterface({input:process.stdin});`
    const withScript = async (body: string, fn: (args: string[]) => Promise<void>): Promise<void> => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-engine-stderr-'))
      const script = path.join(dir, 'engine.cjs')
      fs.writeFileSync(script, body)
      try {
        await fn([script, path.join(dir, 'count')])
      } finally {
        await client?.stop()
        client = null
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }
    const rejection = async (c: EngineClient): Promise<string> => {
      const err = await c.request('x', {}).promise.catch((e: EngineError) => e)
      return (err as EngineError).message
    }

    it('reports exit code and last stderr line; diagnostics keep the full tail', async () => {
      const body = `${RL}${READY}rl.on('line',()=>{process.stderr.write('Traceback line one\\nValueError: bad\\n');setTimeout(()=>process.exit(7),50)});`
      await withScript(body, async (args) => {
        const diagnostics: string[] = []
        client = new EngineClient({ command: process.execPath, args, onDiagnostic: (d) => diagnostics.push(d.message) })
        await client.start()
        const message = await rejection(client)
        expect(message).toContain('exit code 7: ValueError: bad')
        expect(message).not.toContain('Traceback')
        expect(diagnostics.join('\n')).toContain('Traceback line one')
      })
    })

    it('redactHome replaces the home dir and X:\\Users\\name paths with ~', () => {
      expect(redactHome(`open ${os.homedir()}\\a.py`)).toBe('open ~\\a.py')
      expect(redactHome('E:\\Users\\bob\\x.py failed')).toBe('~\\x.py failed')
    })

    it('truncates the stderr tail to STDERR_TAIL_CHARS in diagnostics', async () => {
      const body = `${RL}${READY}rl.on('line',()=>{process.stderr.write('A'.repeat(3000)+'END');setTimeout(()=>process.exit(1),50)});`
      await withScript(body, async (args) => {
        const diagnostics: string[] = []
        client = new EngineClient({ command: process.execPath, args, onDiagnostic: (d) => diagnostics.push(d.message) })
        await client.start()
        await rejection(client)
        const msg = diagnostics.find((m) => m.includes('exited unexpectedly'))!
        expect(msg.endsWith('END)')).toBe(true)
        expect(msg.match(/A+/)![0].length).toBe(997)
      })
    })

    it('resets the tail on restart and leaves no trailing space when stderr is empty', async () => {
      const body = `const fs=require('fs');const c=process.argv[2];const n=fs.existsSync(c)?1:0;fs.writeFileSync(c,'x');${RL}${READY}rl.on('line',()=>{if(n===0)process.stderr.write('first-run-failure\\n');setTimeout(()=>process.exit(1),50)});`
      await withScript(body, async (args) => {
        client = new EngineClient({ command: process.execPath, args })
        await client.start()
        expect(await rejection(client)).toContain('first-run-failure')
        const second = await rejection(client)
        expect(second).not.toContain('first-run-failure')
        expect(second).toContain('exit code 1')
        await rejection(client)
        expect(await rejection(client)).toBe('Engine crashed 3 times in 60s and will not restart')
      })
    })
  })
})
