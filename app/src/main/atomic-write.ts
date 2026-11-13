import fs from 'fs'
import path from 'path'

const LOCK_CODES = ['EPERM', 'EACCES', 'EBUSY']
/** Windows denies replacing a file that antivirus, the indexer or a sync client has open; such locks clear within a moment. */
const RENAME_RETRY_DELAYS_MS = [50, 100, 200]

function renameWithRetrySync(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.renameSync(from, to)
    } catch (error) {
      if (attempt >= RENAME_RETRY_DELAYS_MS.length || !LOCK_CODES.includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_RETRY_DELAYS_MS[attempt])
    }
  }
}

/** Replace a file only after its temporary contents have reached disk. */
export function writeFileAtomicSync(file: string, text: string): void {
  const tmp = `${file}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const fd = fs.openSync(tmp, 'w')
    try {
      fs.writeFileSync(fd, text, 'utf-8')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    renameWithRetrySync(tmp, file)
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {}
    throw error
  }
}
