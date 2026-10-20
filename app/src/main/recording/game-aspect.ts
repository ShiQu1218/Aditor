import fs from 'fs'
import os from 'os'
import path from 'path'

/** Render aspects Apex offers; the engine maps the HUD layout from them (engine/aditor/layout.py). */
const SUPPORTED_ASPECTS = [16 / 9, 16 / 10, 4 / 3, 5 / 4]
const ASPECT_TOLERANCE = 0.01

export function apexVideoConfigPath(home = os.homedir()): string {
  return path.join(home, 'Saved Games', 'Respawn', 'Apex', 'local', 'videoconfig.txt')
}

/** Return the render resolution as `WxH` for the engine's `--aspect`, or null when absent or not a supported aspect. */
export function parseVideoConfig(text: string): string | null {
  const clean = text.replace(/\0/g, '')
  const value = (key: string): number => Number(new RegExp(`"setting\\.${key}"\\s+"(\\d+)"`).exec(clean)?.[1] ?? NaN)
  const width = value('defaultres')
  const height = value('defaultresheight')
  if (!(width > 0 && height > 0)) return null
  const ratio = width / height
  return SUPPORTED_ASPECTS.some((aspect) => Math.abs(ratio - aspect) / aspect <= ASPECT_TOLERANCE) ? `${width}x${height}` : null
}

/** A missing or unreadable config means the aspect is unknown, so detection keeps the 16:9 layout. */
export async function readGameAspect(home = os.homedir()): Promise<string | null> {
  try {
    return parseVideoConfig(await fs.promises.readFile(apexVideoConfigPath(home), 'utf8'))
  } catch {
    return null
  }
}
