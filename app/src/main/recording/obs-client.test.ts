import { afterEach, describe, expect, it } from 'vitest'
import { ObsClient } from './obs-client'
import { fakeObs } from './obs-test-support'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
describe('OBS WebSocket v5', () => {
  it('checks the version after authentication, starts and stops recording, and receives the output path', async () => {
    const server = await fakeObs({ password: '測試密碼', outputPath: 'D:/OBS/original.mkv' })
    cleanup.push(server.close)
    const client = new ObsClient(); cleanup.push(() => client.close())
    await client.connect('127.0.0.1', server.port, '測試密碼')
    expect(await client.version()).toEqual({ obsVersion: '31.0.0', obsWebSocketVersion: '5.5.0' })
    expect((await client.status()).outputActive).toBe(false)
    await client.start()
    expect(await client.stop()).toBe('D:/OBS/original.mkv')
  })
  it('does not expose the password on authentication failure and reports a clear connection error', async () => {
    const server = await fakeObs({ password: '正確密碼' }); cleanup.push(server.close)
    const client = new ObsClient(100); cleanup.push(() => client.close())
    await expect(client.connect('127.0.0.1', server.port, '不可洩漏')).rejects.toThrow('驗證')
    await expect(client.connect('127.0.0.1', 1)).rejects.toThrow('OBS')
  })
  it.each(['hello', 'request'] as const)('Connection or command times out when the server does not respond: %s', async (stall) => {
    const server = await fakeObs({ stall }); cleanup.push(server.close)
    const client = new ObsClient(100); cleanup.push(() => client.close())
    if (stall === 'hello') await expect(client.connect('127.0.0.1', server.port)).rejects.toThrow('OBS')
    else {
      await client.connect('127.0.0.1', server.port)
      await expect(client.status()).rejects.toThrow('逾時')
    }
  })
})
