import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { AditorrecClient, RecorderError } from './aditorrec-client'
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

describe('aditorrec JSON-lines client', () => {
  it('握手、遞增 id 的亂序回覆、事件及正常停止', async () => {
    const root = tempRoot(); roots.push(root)
    const trace = path.join(root, 'trace.jsonl')
    const value = new AditorrecClient(fakeCommand('normal', { FAKE_RECORDER_TRACE: trace }))
    clients.push(value)
    const events: string[] = []
    value.on('event', (ev) => events.push(ev.ev))
    expect((await value.hello()).audio.render[0].name).toBe('系統聲音')
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

  it.each(['invalid-json', 'oversize'])('拒絕不合法協定：%s', async (mode) => {
    await expect(client(mode).hello()).rejects.toMatchObject({ code: 'bad_reply' })
  })

  it('保留最後 64 KB stderr 並拒絕所有等待中的請求', async () => {
    const value = client('stderr-exit')
    const error = await value.hello().catch((e: RecorderError) => e)
    if (!(error instanceof RecorderError)) throw new Error('測試預期收到錄影程序錯誤')
    expect(error.code).toBe('recorder_crashed')
    expect(error.message).toContain('最後的錯誤')
    expect(Buffer.byteLength(error.message)).toBeLessThan(65640)
  })

  it('hello 10 秒逾時並可關閉子程序', async () => {
    vi.useFakeTimers()
    const value = client('hello-timeout')
    const result = value.hello().catch((error) => error)
    await vi.advanceTimersByTimeAsync(10000)
    expect(await result).toMatchObject({ code: 'recorder_timeout' })
  })

  it('stop 15 秒逾時後關閉，且啟動中的事件等待可取消', async () => {
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

  it('找不到執行檔會回報錯誤', async () => {
    const root = tempRoot(); roots.push(root)
    const value = new AditorrecClient({ command: path.join(root, 'missing.exe'), args: [] })
    clients.push(value)
    await expect(value.hello()).rejects.toMatchObject({ code: 'recorder_spawn' })
  })
})
