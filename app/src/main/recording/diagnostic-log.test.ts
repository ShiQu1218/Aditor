import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createDiagnosticLog } from './diagnostic-log'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

describe('錄影診斷紀錄', () => {
  it('每則一行、附時間、換行字元不會拆行', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-log-')); dirs.push(dir)
    const file = path.join(dir, 'recording.log')
    const log = createDiagnosticLog(file, () => new Date('2026-10-18T13:22:00.000Z'))
    log('begin pid=42')
    log('notice error: a\nb')
    expect(fs.readFileSync(file, 'utf8')).toBe('2026-10-18T13:22:00.000Z begin pid=42\n2026-10-18T13:22:00.000Z notice error: a b\n')
  })

  it('超過上限時保留一代舊紀錄', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-log-')); dirs.push(dir)
    const file = path.join(dir, 'recording.log')
    fs.writeFileSync(file, 'x'.repeat(1024 * 1024 + 1))
    createDiagnosticLog(file)('after rotate')
    expect(fs.statSync(`${file}.old`).size).toBe(1024 * 1024 + 1)
    expect(fs.readFileSync(file, 'utf8')).toMatch(/ after rotate\n$/)
  })

  it('寫入失敗不丟出錯誤', () => {
    expect(() => createDiagnosticLog(path.join(os.tmpdir(), 'missing-dir-aditor', 'x', 'recording.log'))('x')).not.toThrow()
  })
})
