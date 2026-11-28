import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { recordingError } from './errors'
import { sanitizeTelemetryEvent } from '../../shared/telemetry'

describe('recording error codes', () => {
  it('keeps the message and attaches the code', () => {
    const error = recordingError('INDEX_MISSING', 'private message')
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ message: 'private message', code: 'INDEX_MISSING' })
  })

  it('uses only codes that survive the telemetry error_code allowlist', () => {
    const codes = fs.readdirSync(__dirname).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .flatMap((file) => [...fs.readFileSync(path.join(__dirname, file), 'utf8').matchAll(/recordingError\('([^']*)'/g)].map((m) => m[1]))
    expect(codes.length).toBeGreaterThan(50)
    for (const code of new Set(codes)) {
      expect(sanitizeTelemetryEvent({ tags: { component: 'recording-service', error_code: code } }).tags, code)
        .toEqual({ component: 'recording-service', error_code: code })
    }
  })
})
