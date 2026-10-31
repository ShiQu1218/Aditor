import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { AditorrecClient, HELLO_TIMEOUT_MS, RecorderError, recorderTags } from './aditorrec-client'
import { fakeCommand, tempRoot } from './test-support'

const clients: AditorrecClient[] = []
const roots: string[] = []
function client(mode = 'normal'): AditorrecClient {
  const value = new AditorrecClient(fakeCommand(mode))
  clients.push(value)
  return value
}
afterEach(async () => {
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
    const value = new AditorrecClient({ command: path.join(root, 'missing.exe'), args: [] })
    clients.push(value)
    await expect(value.hello()).rejects.toMatchObject({ code: 'recorder_spawn' })
  })
})
