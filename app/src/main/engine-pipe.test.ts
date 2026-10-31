import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import { PassThrough, Writable } from 'stream'
import { EngineClient } from './engine'

vi.mock('child_process', () => ({ spawn: vi.fn() }))

function fakeProcess() {
  let broken = false
  const proc = Object.assign(new EventEmitter(), {
    stdin: new Writable({ write(_chunk, _encoding, callback) {
      callback(broken ? Object.assign(new Error('synthetic broken pipe'), { code: 'EPIPE' }) : null)
    } }),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => { queueMicrotask(() => proc.emit('close', 1)); return true }),
    breakPipe: () => { broken = true }
  })
  return proc
}

describe('EngineClient broken input pipe', () => {
  let client: EngineClient | undefined

  afterEach(async () => {
    await client?.stop()
    vi.resetAllMocks()
  })

  function setup() {
    const processes: ReturnType<typeof fakeProcess>[] = []
    vi.mocked(spawn).mockImplementation(() => {
      const proc = fakeProcess()
      // Real child processes announce a successful start before any output.
      queueMicrotask(() => proc.emit('spawn'))
      processes.push(proc)
      return proc as unknown as ReturnType<typeof spawn>
    })
    client = new EngineClient({ command: 'synthetic-engine', args: [] })
    return { engine: client, processes }
  }

  it('handles stdin errors even when there is no write callback', async () => {
    const { engine, processes } = setup()
    const started = engine.start()
    const rejected = expect(started).rejects.toMatchObject({ code: 'engine_crashed' })
    const queued = expect(engine.request('probe', {}).promise).rejects.toMatchObject({ code: 'engine_crashed' })
    expect(() => processes[0].stdin.emit('error', new Error('synthetic broken pipe'))).not.toThrow()
    await rejected
    await queued
  })

  it.each(['request', 'cancel'])('rejects all pending requests after a failed %s write and restarts', async (operation) => {
    const { engine, processes } = setup()
    const started = engine.start()
    const proc = processes[0]
    proc.stdout.write('{"type":"ready"}\n')
    await started
    const pending = engine.request('analyze', {})
    const rejected = expect(pending.promise).rejects.toMatchObject({ code: 'engine_crashed' })
    proc.breakPipe()
    if (operation === 'request') {
      await expect(engine.request('probe', {}).promise).rejects.toMatchObject({ code: 'engine_crashed' })
    } else {
      engine.cancel(pending.id)
    }
    await rejected
    await vi.waitFor(() => expect(processes).toHaveLength(2))
    expect(proc.kill).toHaveBeenCalledOnce()
    processes[1].stdout.write('{"type":"ready"}\n')
    const next = engine.request('probe', {})
    // A late error from the previous process must not reject the restarted process's request.
    proc.stdin.emit('error', new Error('late synthetic pipe error'))
    processes[1].stdout.write(JSON.stringify({ type: 'result', id: next.id, data: true }) + '\n')
    await expect(next.promise).resolves.toBe(true)
  })

  it('consumes a pipe error during shutdown without restarting', async () => {
    const { engine, processes } = setup()
    const started = engine.start()
    processes[0].stdout.write('{"type":"ready"}\n')
    await started
    const stopped = engine.stop()
    expect(() => processes[0].stdin.emit('error', new Error('synthetic shutdown pipe error'))).not.toThrow()
    await stopped
    expect(processes).toHaveLength(1)
    expect(processes[0].kill).toHaveBeenCalledOnce()
  })
})
