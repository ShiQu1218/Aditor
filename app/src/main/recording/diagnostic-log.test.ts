import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createDiagnosticLog } from './diagnostic-log'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

describe('recording diagnostic log', () => {
  it('writes one timestamped line per entry without splitting embedded newlines', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-log-')); dirs.push(dir)
    const file = path.join(dir, 'recording.log')
    const log = createDiagnosticLog(file, () => new Date('2026-10-18T13:22:00.000Z'))
    log('begin pid=42')
    log('notice error: a\nb')
    expect(fs.readFileSync(file, 'utf8')).toBe('2026-10-18T13:22:00.000Z begin pid=42\n2026-10-18T13:22:00.000Z notice error: a b\n')
  })

  it('keeps one previous log generation after exceeding the size limit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-log-')); dirs.push(dir)
    const file = path.join(dir, 'recording.log')
    fs.writeFileSync(file, 'x'.repeat(1024 * 1024 + 1))
    createDiagnosticLog(file)('after rotate')
    expect(fs.statSync(`${file}.old`).size).toBe(1024 * 1024 + 1)
    expect(fs.readFileSync(file, 'utf8')).toMatch(/ after rotate\n$/)
  })

  it('does not throw when writing fails', () => {
    expect(() => createDiagnosticLog(path.join(os.tmpdir(), 'missing-dir-aditor', 'x', 'recording.log'))('x')).not.toThrow()
  })
})
