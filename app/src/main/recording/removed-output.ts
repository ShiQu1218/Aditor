import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'

function markerPath(dir: string, output: string): string {
  const key = createHash('sha1').update(path.resolve(output).toLowerCase()).digest('hex')
  return path.join(dir, `removed-${key}`)
}

/** Persist deletion intent before unlinking, independently of the clipper's asynchronous marker writes. */
export function recordOutputRemoval(dir: string, output: string): void {
  const fd = fs.openSync(markerPath(dir, output), 'w')
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}

export function outputWasRemoved(dir: string, output: string): boolean {
  // A failed unlink leaves the output intact and must not suppress its finalization.
  return fs.existsSync(markerPath(dir, output)) && !fs.existsSync(output)
}
