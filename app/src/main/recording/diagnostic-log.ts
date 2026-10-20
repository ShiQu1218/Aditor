/**
 * Recording diagnostics: timestamp each line and fsync it immediately. Ordinary writes may
 * remain cached and be lost during a system crash, so this log must show what the recorder
 * was doing at the time. Event volume is low, making synchronous writes negligible.
 */
import fs from 'fs'

/** Rename the previous log to `.old` at this size, keeping only one generation. */
const MAX_LOG_BYTES = 1024 * 1024

export function createDiagnosticLog(file: string, now: () => Date = () => new Date()): (message: string) => void {
  return (message) => {
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.old`)
      const fd = fs.openSync(file, 'a')
      try {
        fs.writeSync(fd, `${now().toISOString()} ${message.replace(/[\r\n]+/g, ' ')}\n`)
        fs.fsyncSync(fd)
      } finally { fs.closeSync(fd) }
    } catch { /* A diagnostic logging failure must not affect recording. */ }
  }
}
