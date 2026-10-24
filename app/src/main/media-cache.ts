import fs from 'fs'

/** Source identity captured before rendering, so replacing a video also invalidates its preview. */
export function sourceStamp(source: string): string | null {
  // shortcut: size/mtime detect ordinary replacements; hash content if callers preserve both fields.
  try {
    const stat = fs.statSync(source)
    return stat.isFile() ? JSON.stringify([stat.size, stat.mtimeMs]) : null
  } catch { return null }
}

export function mediaCacheIsCurrent(source: string, output: string): boolean {
  const stamp = sourceStamp(source)
  if (stamp === null) return false
  try { return fs.statSync(output).isFile() && fs.readFileSync(output + '.source', 'utf8') === stamp }
  catch { return false }
}

export function stampMediaCache(output: string, stamp: string | null): void {
  if (stamp !== null) fs.writeFileSync(output + '.source', stamp, 'utf8')
}
