import fs from 'fs'
import path from 'path'

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
    fs.renameSync(tmp, file)
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {}
    throw error
  }
}
