import { describe, it, expect, afterEach } from 'vitest'
import { EngineClient } from './engine'
import { engineCommand } from '../shared/paths'

describe('EngineClient with real Python engine', () => {
  let client: EngineClient | null = null

  afterEach(async () => {
    if (client) {
      await client.stop()
      client = null
    }
  })

  it('connects to real engine and gets version 0.1.0', async () => {
    const cmd = engineCommand(false)
    client = new EngineClient(cmd)
    const res = await client.start()
    expect(res.engineVersion).toBe('0.2.0')
  })
})
