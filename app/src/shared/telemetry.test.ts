import { describe, expect, it } from 'vitest'
import { redactTelemetryText, sanitizeTelemetryEvent } from './telemetry'
import { migrateSettings } from '../main/settings'

describe('telemetry privacy boundary', () => {
  it('redacts file paths containing spaces, including UNC and file URLs', () => {
    for (const value of ['C:\\Users\\Alice Smith\\private video.mp4', '\\\\server\\Alice Smith\\private video.mp4', 'file:///C:/Users/Alice Smith/private video.mp4']) {
      expect(redactTelemetryText(`Cannot read '${value}'`)).toBe("Cannot read '[local path]'")
    }
  })
  it('enables new and legacy defaults while preserving an explicit opt-out', () => {
    for (const raw of [{}, { telemetryEnabled: 'true' }, { telemetryEnabled: 1 }]) {
      expect(migrateSettings(raw).telemetryEnabled).toBe(true)
    }
    expect(migrateSettings({ telemetryEnabled: false }).telemetryEnabled).toBe(false)
  })

  it('removes application context and sensitive message content while preserving useful frames', () => {
    const clean = sanitizeTelemetryEvent({
      user: { email: 'someone@example.com' },
      request: { headers: { Authorization: 'secret' } },
      extra: { video: 'private.mp4' }, breadcrumbs: [{ message: 'private.mp4' }],
      exception: { values: [{ type: 'Error', value: 'Cannot read C:\\Users\\Alice\\private.mp4 token=private someone@example.com',
        stacktrace: { frames: [{ filename: 'C:/Users/Alice/Aditor/out/main/index.js', function: 'readVideo', lineno: 20, colno: 3, vars: { password: 'secret' }, context_line: 'secret source' }] }
      }] }
    })
    const encoded = JSON.stringify(clean)
    for (const secret of ['Alice', 'private', 'someone', 'secret']) expect(encoded).not.toContain(secret)
    expect(clean.exception?.values?.[0].stacktrace?.frames?.[0]).toMatchObject({ filename: 'app:///out/main/index.js', function: 'readVideo', lineno: 20 })
    expect(clean.user).toEqual({ ip_address: '0.0.0.0' })
    expect(clean).not.toHaveProperty('breadcrumbs')
  })

  it('strips paths, URLs and arbitrary attributes from performance transactions', () => {
    const clean = sanitizeTelemetryEvent({ type: 'transaction', transaction: 'file:///Users/Alice/private.mp4',
      spans: [{ trace_id: 'a', span_id: 'b', start_timestamp: 1, timestamp: 2, description: 'private.mp4', data: { password: 'secret' } }] })
    expect(clean.transaction).toBe('Aditor desktop')
    expect(clean.spans?.[0].data).toEqual({})
    expect(JSON.stringify(clean)).not.toMatch(/Alice|private|secret/)
  })

  it('keeps allowlisted SDK trace origins so Electron startup tracing still recognizes renderer pageloads', () => {
    for (const origin of ['auto.pageload.browser', 'auto.navigation.browser', 'auto.electron.startup'] as const) {
      const clean = sanitizeTelemetryEvent({ type: 'transaction', contexts: { trace: {
        trace_id: 'trace', span_id: 'span', parent_span_id: 'parent', origin, data: { url: 'file:///Users/Alice/private.mp4' }
      } } })
      expect(clean.contexts?.trace).toMatchObject({ trace_id: 'trace', span_id: 'span', parent_span_id: 'parent', origin, op: 'desktop' })
      expect(clean.contexts?.trace).not.toHaveProperty('data')
    }
    const untrusted = sanitizeTelemetryEvent({ type: 'transaction', contexts: { trace: {
      trace_id: 'trace', span_id: 'span', origin: 'https://example.com/Alice' as never
    } } })
    expect(untrusted.contexts?.trace).not.toHaveProperty('origin')
  })

  it('keeps only coarse hardware fields from os, device and gpu contexts', () => {
    const clean = sanitizeTelemetryEvent({ contexts: {
      os: { name: 'Windows', version: '10.0.26300', kernel_version: '10.0.26300', build: 'C:\\Users\\Alice\\x' },
      device: { arch: 'x64', memory_size: 17179869184, processor_count: 16, cpu_description: 'AMD Ryzen 7', processor_frequency: 3800,
        name: 'ALICE-PC', boot_time: '2026-01-01T00:00:00Z' },
      gpu: { name: 'NVIDIA RTX 4070', vendor_name: 'NVIDIA', driver_version: '555.1', id: 1, extra: 'Alice' },
      culture: { locale: 'zh-TW', timezone: 'Asia/Taipei' }
    } })
    expect(clean.contexts?.os).toEqual({ name: 'Windows', version: '10.0.26300', kernel_version: '10.0.26300' })
    expect(clean.contexts?.device).toEqual({ arch: 'x64', memory_size: 17179869184, processor_count: 16, cpu_description: 'AMD Ryzen 7', processor_frequency: 3800 })
    expect(clean.contexts?.gpu).toEqual({ name: 'NVIDIA RTX 4070', vendor_name: 'NVIDIA', driver_version: '555.1', id: 1 })
    expect(clean.contexts).not.toHaveProperty('culture')
    expect(JSON.stringify(clean)).not.toMatch(/Alice|ALICE/)
  })

  it('keeps the user-report tag and redacts paths and emails in the report text', () => {
    const clean = sanitizeTelemetryEvent({ message: 'mail me@example.com about C:\\Users\\Alice\\a.mp4', tags: { component: 'user-report', extra: 'Alice' } })
    expect(clean.tags).toEqual({ component: 'user-report' })
    expect(clean.message).toBe('mail [email] about [local path]')
  })

  it('keeps only well-formed electron/decode tags and the reporter fingerprint', () => {
    const clean = sanitizeTelemetryEvent({ fingerprint: ['preview-av-desync'],
      tags: { component: 'preview-playback', electron: '45.0.1', decode: 'software', user: 'Alice' } })
    expect(clean.tags).toEqual({ component: 'preview-playback', electron: '45.0.1', decode: 'software' })
    expect(clean.fingerprint).toEqual(['preview-av-desync'])
    expect(sanitizeTelemetryEvent({ tags: { component: 'preview-playback', electron: 'C:\\Users\\Alice', decode: 'x' } }).tags)
      .toEqual({ component: 'preview-playback' })
    expect(sanitizeTelemetryEvent({ tags: { electron: '45.0.1' } }).tags).toBeUndefined()
  })

  it('keeps well-formed recorder state tags and drops malformed or unknown ones', () => {
    const clean = sanitizeTelemetryEvent({ tags: { component: 'rust-recorder', capture: 'dda', codec: 'hevc', encoder: 'hevc_nvenc',
      fps: '60', height: '1080', mic: 'on', system_audio: 'off', phase: 'recording', uptime: '<1m', gpu: 'NVIDIA RTX 4070' } })
    expect(clean.tags).toEqual({ component: 'rust-recorder', capture: 'dda', codec: 'hevc', encoder: 'hevc_nvenc',
      fps: '60', height: '1080', mic: 'on', system_audio: 'off', phase: 'recording', uptime: '<1m' })
    expect(sanitizeTelemetryEvent({ tags: { component: 'rust-recorder', capture: 'C:\\Users\\Alice', encoder: 'a b/c', fps: '60fps' } }).tags)
      .toEqual({ component: 'rust-recorder' })
  })

  it('preserves matching Debug IDs with the same safe build-relative path as stack frames', () => {
    const filename = 'C:/Users/Alice/Aditor/out/main/index.js'
    const clean = sanitizeTelemetryEvent({
      debug_meta: { images: [{ type: 'sourcemap', code_file: filename, debug_id: 'fb59d314-d7a5-4e56-9cb2-5aeb2e9833c7' }] },
      exception: { values: [{ stacktrace: { frames: [{ filename, lineno: 10 }] } }] }
    })
    expect(clean.debug_meta?.images?.[0]).toEqual({ type: 'sourcemap', code_file: 'app:///out/main/index.js', debug_id: 'fb59d314-d7a5-4e56-9cb2-5aeb2e9833c7' })
    expect(clean.exception?.values?.[0].stacktrace?.frames?.[0].filename).toBe('app:///out/main/index.js')
    expect(clean.exception?.values?.[0].stacktrace?.frames?.[0]).toHaveProperty('abs_path', 'app:///out/main/index.js')
    expect(JSON.stringify(clean)).not.toContain('Alice')
  })
})
