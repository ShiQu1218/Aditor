import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { AditorrecClient, HELLO_TIMEOUT_MS, LAUNCH_TIMEOUT_MS, PROCESSES_TIMEOUT_MS, RecorderError, recorderTags } from './aditorrec-client'
import { createRecorderGameQuery } from './game-watcher'
import { fakeCommand, tempRoot } from './test-support'
import { LOCALES, setActiveLocale, tr } from '../../shared/locale'

const clients: AditorrecClient[] = []
const roots: string[] = []
function client(mode = 'normal'): AditorrecClient {
  const value = new AditorrecClient(fakeCommand(mode))
  clients.push(value)
  return value
}
afterEach(async () => {
  setActiveLocale('zh-TW')
  for (const value of clients.splice(0)) await value.close()
  vi.useRealTimers()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('recorderTags', () => {
  it('keeps only coarse capture, encoder and audio settings, never device IDs or paths', () => {
    const tags = recorderTags({ pid: 4242, session_dir: 'C:\\Users\\Alice\\rec', capture: 'dda',
      encode: { codec: 'hevc', encoder: 'hevc_nvenc', gpu: '10de:2684', fps: 60, height: 1080, bitrate_kbps: 20000 },
      audio: { render: '{0.0.0.00000000}.{guid}', capture: 'mic-id', mic_enabled: true, render_enabled: false } })
    expect(tags).toEqual({ capture: 'dda', codec: 'hevc', encoder: 'hevc_nvenc', fps: '60', height: '1080', mic: 'on', system_audio: 'off' })
  })
  it('returns no tags for OBS mode or malformed arguments', () => {
    expect(recorderTags({ capture: 'wgc', encode: null, audio: null })).toEqual({ capture: 'wgc' })
    expect(recorderTags({})).toEqual({})
  })
  it('tags diagnostics with the startup phase before recording begins', async () => {
    const onDiagnostic = vi.fn()
    const value = new AditorrecClient(fakeCommand('stderr-exit'), onDiagnostic)
    clients.push(value)
    await expect(value.hello()).rejects.toBeDefined()
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ tags: expect.objectContaining({ phase: 'startup' }) }))
  })
})

describe('aditorrec JSON-lines client', () => {
  it.each(LOCALES)('localizes encoder stall events in %s while keeping English diagnostics', async (locale) => {
    setActiveLocale(locale)
    const root = tempRoot(); roots.push(root)
    const onDiagnostic = vi.fn()
    const value = new AditorrecClient(fakeCommand('encoder-stall'), onDiagnostic)
    clients.push(value)
    const events: Array<Record<string, unknown>> = []
    value.on('event', (event) => events.push(event))
    await value.hello()
    await value.startRecording({ session_dir: root })
    expect(events.find((event) => event.ev === 'warning')).toMatchObject({
      code: 'encoder_stalled', message: tr('編碼暫時停滯，錄影仍在繼續，部分畫面可能遺失。')
    })
    expect(events.find((event) => event.ev === 'error')).toMatchObject({
      code: 'encode_failed', message: tr('編碼已停滯 60 秒，錄影失敗，將嘗試保留已完成的片段。')
    })
    expect(onDiagnostic.mock.calls.map(([diagnostic]) => [diagnostic.code, diagnostic.message])).toEqual([
      ['encoder_stalled', 'Encoding is temporarily stalled; recording continues with dropped video frames. stage=encode input=12'],
      ['encode_failed', 'Encoder stalled for at least 60 seconds. stage=encode input=12']
    ])
  })

  it('reports only audio warnings with recorder state while startup and recording continue', async () => {
    const root = tempRoot(); roots.push(root)
    const onDiagnostic = vi.fn()
    const value = new AditorrecClient(fakeCommand('audio-warnings'), onDiagnostic)
    clients.push(value)
    const events: string[] = []
    value.on('event', (event) => events.push(event.ev))
    await value.hello()
    await value.startRecording({ session_dir: root, capture: 'wgc', audio: { mic_enabled: true, render_enabled: true } })
    expect(onDiagnostic.mock.calls.map(([diagnostic]) => diagnostic.code)).toEqual([
      'audio_device_missing', 'audio_source_lost', 'audio_capture_stalled', 'game_audio_unavailable'
    ])
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      component: 'rust-recorder', tags: { capture: 'wgc', mic: 'on', system_audio: 'on', phase: 'startup' }
    }))
    expect(events.filter((ev) => ev === 'warning')).toHaveLength(5)
    await value.request('ping')
    await value.stop()
  })

  it('keeps only allowlisted probe progress across stderr chunks', async () => {
    const onDiagnostic = vi.fn()
    const value = new AditorrecClient(fakeCommand('probe-exit'), onDiagnostic)
    clients.push(value)
    await expect(value.hello()).rejects.toMatchObject({ code: 'recorder_crashed' })
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ tags: {
      phase: 'startup', probe_stage: 'probe_send', probe_encoder: 'av1_nvenc', exit_code: '0x00000007'
    } }))
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toMatch(/private|secret/)
  })

  it.skipIf(process.platform !== 'win32')('identifies Windows application-control blocks', async () => {
    const onDiagnostic = vi.fn()
    const value = new AditorrecClient(fakeCommand('policy-exit'), onDiagnostic)
    clients.push(value)
    await expect(value.hello()).rejects.toMatchObject({ code: 'recorder_crashed', message: expect.stringContaining('Windows Application Control') })
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ tags: { phase: 'startup', exit_code: '0xC0E90002' } }))
  })
  it.skipIf(process.platform !== 'win32')('relaunches once without a report when Windows fails to load the recorder', async () => {
    const root = tempRoot(); roots.push(root)
    const onDiagnostic = vi.fn()
    const value = new AditorrecClient(fakeCommand('dll-init-once', { FAKE_RECORDER_MARKER: path.join(root, 'launched') }), onDiagnostic)
    clients.push(value)
    await expect(value.hello()).resolves.toMatchObject({ version: '0.1.0' })
    expect(onDiagnostic).not.toHaveBeenCalled()
  })
  it.skipIf(process.platform !== 'win32')('reports the second loader failure as a crash', async () => {
    const onDiagnostic = vi.fn()
    const value = new AditorrecClient(fakeCommand('dll-init'), onDiagnostic)
    clients.push(value)
    await expect(value.ping()).rejects.toMatchObject({ code: 'recorder_crashed' })
    expect(onDiagnostic).toHaveBeenCalledTimes(1)
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ code: 'recorder_crashed', tags: { phase: 'startup', exit_code: '0xC0000142' } }))
  })
  it('reports abnormal exits without forwarding stderr logs to monitoring', async () => {
    const onDiagnostic = vi.fn()
    const value = new AditorrecClient(fakeCommand('stderr-exit'), onDiagnostic)
    clients.push(value)
    await expect(value.hello()).rejects.toMatchObject({ code: 'recorder_crashed' })
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ component: 'rust-recorder', code: 'recorder_crashed' }))
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain('最後的錯誤')
  })
  it('handshakes, handles out-of-order replies with increasing IDs and events, and stops cleanly', async () => {
    const root = tempRoot(); roots.push(root)
    const trace = path.join(root, 'trace.jsonl')
    const value = new AditorrecClient(fakeCommand('normal', { FAKE_RECORDER_TRACE: trace }))
    clients.push(value)
    const events: string[] = []
    value.on('event', (ev) => events.push(ev.ev))
    const caps = await value.hello()
    expect(caps.audio.render[0].name).toBe('系統聲音')
    expect(caps.gpus).toEqual([
      { id: '10de:2684', name: 'NVIDIA GeForce RTX 5080', vendor: 'nvidia', encoders: ['hevc_nvenc', 'h264_nvenc'] },
      { id: '8086:46a6', name: 'Intel Iris Xe Graphics', vendor: 'intel', encoders: ['av1_qsv'] }
    ])
    const first = value.request('ping', { value: 'first', delay: 50 })
    const second = value.request('ping', { value: 'second' })
    expect((await second).value).toBe('second')
    expect((await first).value).toBe('first')
    await value.startRecording({ session_dir: root })
    await value.stop()
    expect(events).toContain('started')
    expect(events).toContain('stopped')
    expect(fs.readFileSync(trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line).id)).toEqual([1, 2, 3, 4, 5])
  })

  it.each(['invalid-json', 'oversize'])('Reject invalid protocol data: %s', async (mode) => {
    await expect(client(mode).hello()).rejects.toMatchObject({ code: 'bad_reply' })
  })

  it('retains the last 64 KB of stderr and rejects all pending requests', async () => {
    const value = client('stderr-exit')
    const error = await value.hello().catch((e: RecorderError) => e)
    if (!(error instanceof RecorderError)) throw new Error('測試預期收到錄影程序錯誤')
    expect(error.code).toBe('recorder_crashed')
    expect(error.message).toContain('最後的錯誤')
    expect(Buffer.byteLength(error.message)).toBeLessThan(65640)
  })

  it('times out hello after 30 seconds and closes the child process', async () => {
    vi.useFakeTimers()
    const value = client('hello-timeout')
    const result = value.hello().catch((error) => error)
    await vi.advanceTimersByTimeAsync(HELLO_TIMEOUT_MS)
    expect(await result).toMatchObject({ code: 'recorder_timeout' })
  })

  it('accepts older recorders without gpus and rejects malformed gpu lists', async () => {
    expect((await client('hello-legacy').hello()).gpus).toEqual([])
    await expect(client('hello-bad-gpus').hello()).rejects.toMatchObject({ code: 'bad_reply' })
  })

  it('closes after stop times out at 15 seconds and allows pending startup-event waits to be cancelled', async () => {
    const root = tempRoot(); roots.push(root)
    const value = client('stop-stall')
    await value.hello()
    vi.useFakeTimers()
    const result = value.stop().catch((error) => error)
    await vi.advanceTimersByTimeAsync(15000)
    expect(await result).toMatchObject({ code: 'recorder_timeout' })
    vi.useRealTimers()
    const stalled = client('start-stall')
    await stalled.hello()
    const pending = stalled.startRecording({ session_dir: root }).catch((error) => error)
    await stalled.close()
    expect(await pending).toMatchObject({ code: 'recorder_closed' })
  })

  it('reports an error when the executable cannot be found', async () => {
    const root = tempRoot(); roots.push(root)
    const onDiagnostic = vi.fn()
    const value = new AditorrecClient({ command: path.join(root, 'missing.exe'), args: [] }, onDiagnostic)
    clients.push(value)
    await expect(value.hello()).rejects.toMatchObject({ code: 'recorder_spawn' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    // The stdin EPIPE and the exit that follow a failed spawn are the same failure, not separate reports.
    expect(onDiagnostic.mock.calls.map(([diagnostic]) => diagnostic.code)).toEqual(['recorder_spawn'])
  })

  it('lists matching processes, handles invalid replies, times out, and relaunches once on loader failure', async () => {
    const root = tempRoot(); roots.push(root)
    const okClient = new AditorrecClient(fakeCommand('normal', {
      FAKE_RECORDER_PROCESSES: JSON.stringify([
        { name: 'r5apex_dx12.exe', pid: 101 },
        { name: 'other.exe', pid: 202 },
        { name: 'VALORANT-Win64-Shipping.exe', pid: 303 }
      ])
    }))
    clients.push(okClient)
    await expect(okClient.processes(['r5apex', 'VALORANT-Win64-Shipping'])).resolves.toEqual([
      { name: 'r5apex_dx12.exe', pid: 101 },
      { name: 'VALORANT-Win64-Shipping.exe', pid: 303 }
    ])

    await expect(client('processes-bad-reply').processes(['r5apex'])).rejects.toMatchObject({ code: 'bad_reply' })

    const onDiagnostic = vi.fn()
    const retryClient = new AditorrecClient(fakeCommand('dll-init-once', {
      FAKE_RECORDER_MARKER: path.join(root, 'launched'),
      FAKE_RECORDER_PROCESSES: JSON.stringify([{ name: 'r5apex.exe', pid: 77 }])
    }), onDiagnostic)
    clients.push(retryClient)
    await expect(retryClient.processes(['r5apex'])).resolves.toEqual([{ name: 'r5apex.exe', pid: 77 }])
    expect(onDiagnostic).not.toHaveBeenCalled()

    // A warm recorder that stops answering times out on the short processes budget.
    const warmClient = new AditorrecClient(fakeCommand('processes-timeout-after-first'))
    clients.push(warmClient)
    await expect(warmClient.processes(['r5apex'])).resolves.toEqual([])
    vi.useFakeTimers()
    const warm = warmClient.processes(['r5apex']).catch((error) => error)
    await vi.advanceTimersByTimeAsync(PROCESSES_TIMEOUT_MS)
    expect(await warm).toMatchObject({ code: 'recorder_timeout' })

    // The first command after a launch also waits for process startup, so it gets the launch budget.
    const coldClient = client('processes-timeout')
    let settled = false
    const cold = coldClient.processes(['r5apex']).catch((error) => error).finally(() => { settled = true })
    await vi.advanceTimersByTimeAsync(PROCESSES_TIMEOUT_MS)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(LAUNCH_TIMEOUT_MS - PROCESSES_TIMEOUT_MS)
    expect(await cold).toMatchObject({ code: 'recorder_timeout' })
  })
})

describe('createRecorderGameQuery', () => {
  it('reuses one recorder process across find calls, respects game priority, and closes the process on close()', async () => {
    const root = tempRoot(); roots.push(root)
    const trace = path.join(root, 'trace.jsonl')
    const spawned: AditorrecClient[] = []
    const fallback = vi.fn(async () => null)
    const query = createRecorderGameQuery(() => {
      const c = new AditorrecClient(fakeCommand('normal', {
        FAKE_RECORDER_TRACE: trace,
        FAKE_RECORDER_PROCESSES: JSON.stringify([
          { name: 'VALORANT-Win64-Shipping.exe', pid: 8 },
          { name: 'r5apex_launcher.exe', pid: 55 },
          { name: 'r5apex_dx12.exe', pid: 9 }
        ])
      }))
      spawned.push(c)
      clients.push(c)
      return c
    }, fallback)

    await expect(query.find()).resolves.toEqual({ game: 'apex', pid: 9 })
    const firstPid = spawned[0].pid
    expect(firstPid).toBeTypeOf('number')
    await expect(query.find()).resolves.toEqual({ game: 'apex', pid: 9 })
    await expect(query.find()).resolves.toEqual({ game: 'apex', pid: 9 })
    expect(spawned).toHaveLength(1)
    expect(spawned[0].pid).toBe(firstPid)
    expect(fallback).not.toHaveBeenCalled()
    expect(fs.readFileSync(trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line).id)).toEqual([1, 2, 3])

    await query.close()
    expect(spawned[0].pid).toBeUndefined()
    expect(() => process.kill(firstPid!, 0)).toThrow()

    await expect(query.find()).resolves.toEqual({ game: 'apex', pid: 9 })
    expect(spawned).toHaveLength(2)
    await query.close()
  })

  it('ignores non-matching prefixes and falls back to valorant when apex is absent', async () => {
    const query = createRecorderGameQuery(() => {
      const c = new AditorrecClient(fakeCommand('normal', {
        FAKE_RECORDER_PROCESSES: JSON.stringify([
          { name: 'r5apex_launcher.exe', pid: 55 },
          { name: 'VALORANT-Win64-Shipping.exe', pid: 456 }
        ])
      }))
      clients.push(c)
      return c
    }, async () => null)

    await expect(query.find()).resolves.toEqual({ game: 'valorant', pid: 456 })
    await query.close()
  })

  it('falls back on client error, stops using the client after 3 consecutive failures, and resets on success or close()', async () => {
    let mode = 'processes-error'
    let makeCalls = 0
    const created: AditorrecClient[] = []
    const fallback = vi.fn(async () => ({ game: 'apex' as const, pid: 777 }))
    const query = createRecorderGameQuery(() => {
      makeCalls++
      const c = new AditorrecClient(fakeCommand(mode, {
        FAKE_RECORDER_PROCESSES: JSON.stringify([{ name: 'r5apex.exe', pid: 888 }])
      }))
      created.push(c)
      clients.push(c)
      return c
    }, fallback)

    // Two failures followed by a client success resets the consecutive failure counter.
    await expect(query.find()).resolves.toEqual({ game: 'apex', pid: 777 })
    expect(created[0].pid).toBeUndefined()
    await expect(query.find()).resolves.toEqual({ game: 'apex', pid: 777 })
    mode = 'normal'
    await expect(query.find()).resolves.toEqual({ game: 'apex', pid: 888 })
    expect(makeCalls).toBe(3)

    // Three consecutive failures stop creating clients and route directly to the fallback.
    await created[2].close()
    mode = 'processes-error'
    await expect(query.find()).resolves.toEqual({ game: 'apex', pid: 777 })
    await expect(query.find()).resolves.toEqual({ game: 'apex', pid: 777 })
    await expect(query.find()).resolves.toEqual({ game: 'apex', pid: 777 })
    expect(makeCalls).toBe(5)
    await expect(query.find()).resolves.toEqual({ game: 'apex', pid: 777 })
    await expect(query.find()).resolves.toEqual({ game: 'apex', pid: 777 })
    expect(makeCalls).toBe(5)
    expect(fallback).toHaveBeenCalledTimes(7)

    // close() resets the failure limit so the next find() tries the recorder again.
    mode = 'normal'
    await query.close()
    await expect(query.find()).resolves.toEqual({ game: 'apex', pid: 888 })
    expect(makeCalls).toBe(6)
    await query.close()
  })

  it('shares one query between concurrent find calls, so a failure runs the fallback once', async () => {
    let makeCalls = 0
    const fallback = vi.fn(async () => null)
    const query = createRecorderGameQuery(() => {
      makeCalls++
      const c = new AditorrecClient(fakeCommand('processes-error'))
      clients.push(c)
      return c
    }, fallback)

    await expect(Promise.all([query.find(), query.find()])).resolves.toEqual([null, null])
    expect(makeCalls).toBe(1)
    expect(fallback).toHaveBeenCalledTimes(1)
    await query.close()
  })

  it('resolves an in-flight find to null without the fallback when close() runs during the query', async () => {
    const fallback = vi.fn(async () => ({ game: 'apex' as const, pid: 1 }))
    const query = createRecorderGameQuery(() => {
      const c = new AditorrecClient(fakeCommand('processes-timeout'))
      clients.push(c)
      return c
    }, fallback)

    const pending = query.find()
    await new Promise((resolve) => setTimeout(resolve, 100))
    await query.close()
    await expect(pending).resolves.toBeNull()
    expect(fallback).not.toHaveBeenCalled()
  })

  it('replaces a recorder that exits between polls with a new client', async () => {
    const created: AditorrecClient[] = []
    const query = createRecorderGameQuery(() => {
      const c = new AditorrecClient(fakeCommand('normal', {
        FAKE_RECORDER_PROCESSES: JSON.stringify([{ name: 'r5apex.exe', pid: 321 }])
      }))
      created.push(c)
      clients.push(c)
      return c
    }, async () => null)

    await expect(query.find()).resolves.toEqual({ game: 'apex', pid: 321 })
    const crashed = new Promise((resolve) => created[0].once('crash', resolve))
    process.kill(created[0].pid!)
    await crashed
    await expect(query.find()).resolves.toEqual({ game: 'apex', pid: 321 })
    expect(created).toHaveLength(2)
    await query.close()
  })
})
