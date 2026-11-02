import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { checkExecutable, spawnFailure } from './child-spawn'
import { EngineClient } from './engine'
import { AditorrecClient } from './recording/aditorrec-client'
import { LiveEngine } from './recording/live-engine'
import { LOCALES, setActiveLocale } from '../shared/locale'
import { sanitizeTelemetryEvent } from '../shared/telemetry'

vi.mock('child_process', () => ({ spawn: vi.fn() }))
afterEach(() => { vi.resetAllMocks(); setActiveLocale('zh-TW') })

describe('executable preflight and private spawn diagnostics', () => {
  it('checks absolute files while preserving PATH lookup and original filesystem errno', () => {
    expect(() => checkExecutable('synthetic-engine')).not.toThrow()
    expect(() => checkExecutable(process.execPath)).not.toThrow()
    expect(() => checkExecutable(os.tmpdir())).toThrowError(expect.objectContaining({ code: 'ENOENT' }))
    expect(() => checkExecutable(path.join(os.tmpdir(), 'aditor-absent', 'engine.exe')))
      .toThrowError(expect.objectContaining({ code: 'ENOENT' }))
    const stat = vi.spyOn(fs, 'statSync').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) })
    try { expect(() => checkExecutable(process.execPath)).toThrowError(expect.objectContaining({ code: 'EACCES' })) }
    finally { stat.mockRestore() }
  })

  it.each(LOCALES)('provides missing-file and permission guidance in %s', (locale) => {
    setActiveLocale(locale)
    for (const code of ['ENOENT', 'EACCES']) {
      const failure = spawnFailure(Object.assign(new Error('spawn C:/private/name.exe ' + code), { code, syscall: 'spawn C:/private/name.exe' }))
      if (code === 'ENOENT') expect(failure.message).toContain('Aditor')
      expect(failure.report).toBe(`Required program could not be started (${code})`)
      expect(failure.message).not.toContain('private')
      expect(failure.message).not.toContain('{code}')
      if (code === 'EACCES') expect(failure.message).toContain(code)
      if (locale !== 'zh-TW') expect(failure.message).not.toContain('請')
      expect(sanitizeTelemetryEvent({ tags: { component: 'rust-engine', ...failure.tags } }).tags)
        .toEqual({ component: 'rust-engine', spawn_errno: code, spawn_syscall: 'spawn' })
    }
  })

  it('rejects arbitrary errno and syscall values at the telemetry boundary', () => {
    expect(spawnFailure({ code: 'C:/private' }).tags.spawn_errno).toBe('UNKNOWN')
    expect(sanitizeTelemetryEvent({ tags: { component: 'rust-engine', spawn_errno: 'C:/private', spawn_syscall: 'spawn C:/private' } }).tags)
      .toEqual({ component: 'rust-engine' })
  })

  it('allows a new engine startup after a synchronous failure', async () => {
    vi.mocked(spawn).mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) })
    const client = new EngineClient({ command: process.execPath, args: [] })
    await expect(client.start()).rejects.toMatchObject({ code: 'engine_spawn' })
    await expect(client.start()).rejects.toMatchObject({ code: 'engine_spawn' })
    expect(spawn).toHaveBeenCalledTimes(2)
    await client.stop()
  })
})

describe.each(['engine', 'recorder', 'live'] as const)('%s spawn failures', (kind) => {
  it.each(['preflight', 'sync', 'async', 'race'] as const)('reports %s errors with errno and user guidance', async (mode) => {
    setActiveLocale('ja')
    const onDiagnostic = vi.fn()
    const errno = mode === 'preflight' || mode === 'race' ? 'ENOENT' : 'EACCES'
    const error = Object.assign(new Error('spawn C:/private/app.exe ' + errno), { code: errno, syscall: 'spawn C:/private/app.exe' })
    const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() })
    vi.mocked(spawn).mockImplementation(() => {
      if (mode === 'sync') throw error
      return proc as unknown as ReturnType<typeof spawn>
    })
    const command = { command: mode === 'preflight' ? path.join(os.tmpdir(), 'aditor-absent', 'engine.exe') : process.execPath, args: [] }
    const client = kind === 'engine' ? new EngineClient({ ...command, onDiagnostic })
      : kind === 'recorder' ? new AditorrecClient(command, onDiagnostic)
        : new LiveEngine({ command, args: [], onDiagnostic })
    const pending = client instanceof EngineClient ? client.start() : client instanceof AditorrecClient ? client.hello() : Promise.resolve(client.start())
    const rejected = kind === 'live' ? pending : expect(pending).rejects.toMatchObject({ code: kind === 'engine' ? 'engine_spawn' : 'recorder_spawn', message: expect.stringContaining(errno === 'ENOENT' ? 'Aditor' : errno) })
    if (mode === 'async' || mode === 'race') {
      proc.emit('error', error)
      expect(() => proc.stdin.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))).not.toThrow()
      proc.emit('close', -4058, null)
    }
    await rejected
    expect(onDiagnostic).toHaveBeenCalledOnce()
    expect(onDiagnostic.mock.calls[0][0]).toMatchObject({
      code: kind === 'recorder' ? 'recorder_spawn' : 'engine_spawn',
      message: `Required program could not be started (${errno})`,
      tags: { spawn_errno: errno, spawn_syscall: 'spawn' }
    })
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain('private')
    if (mode === 'preflight') expect(spawn).not.toHaveBeenCalled()
    if (client instanceof AditorrecClient) await client.close()
    else await client.stop()
  })
})
