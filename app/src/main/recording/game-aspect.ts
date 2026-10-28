import fs from 'fs'
import os from 'os'
import path from 'path'
import { DEFAULT_GAME, type GameId } from '../../shared/games'

/** Render aspects Apex and Valorant offer; the engine maps each game's HUD layout from them (engine/src/layout.rs, valorant/profile.rs). */
const SUPPORTED_ASPECTS = [16 / 9, 16 / 10, 4 / 3, 5 / 4]
const ASPECT_TOLERANCE = 0.01

function supported(width: number, height: number, aspects: number[]): string | null {
  if (!(width > 0 && height > 0)) return null
  const ratio = width / height
  return aspects.some((aspect) => Math.abs(ratio - aspect) / aspect <= ASPECT_TOLERANCE) ? `${width}x${height}` : null
}

export function apexVideoConfigPath(home = os.homedir()): string {
  return path.join(home, 'Saved Games', 'Respawn', 'Apex', 'local', 'videoconfig.txt')
}

/** Return the render resolution as `WxH` for the engine's `--aspect`, or null when absent or not a supported aspect. */
export function parseVideoConfig(text: string): string | null {
  const clean = text.replace(/\0/g, '')
  const value = (key: string): number => Number(new RegExp(`"setting\\.${key}"\\s+"(\\d+)"`).exec(clean)?.[1] ?? NaN)
  return supported(value('defaultres'), value('defaultresheight'), SUPPORTED_ASPECTS)
}

/** `GameUserSettings.ini` from `%LOCALAPPDATA%\VALORANT\Saved\Config\<account>\WindowsClient`. */
export function parseValorantSettings(text: string): string | null {
  const value = (key: string): number => Number(new RegExp(`^\\s*${key}\\s*=\\s*(\\d+)\\s*$`, 'mi').exec(text)?.[1] ?? NaN)
  return supported(value('ResolutionSizeX'), value('ResolutionSizeY'), SUPPORTED_ASPECTS)
}

/** Each Riot account has its own config folder; the most recently written one belongs to the current account. */
async function latestValorantSettings(localAppData: string): Promise<string> {
  const root = path.join(localAppData, 'VALORANT', 'Saved', 'Config')
  let best: { file: string; mtime: number } | null = null
  for (const entry of await fs.promises.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = path.join(root, entry.name, 'WindowsClient', 'GameUserSettings.ini')
    const stat = await fs.promises.stat(file).catch(() => null)
    if (stat?.isFile() && (!best || stat.mtimeMs > best.mtime)) best = { file, mtime: stat.mtimeMs }
  }
  if (!best) throw new Error('GameUserSettings.ini not found')
  return fs.promises.readFile(best.file, 'utf8')
}

/** A missing or unreadable config means the aspect is unknown, so detection keeps the 16:9 layout. */
export async function readGameAspect(game: GameId = DEFAULT_GAME, home = os.homedir(),
  localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')): Promise<string | null> {
  try {
    if (game === 'valorant') return parseValorantSettings(await latestValorantSettings(localAppData))
    return parseVideoConfig(await fs.promises.readFile(apexVideoConfigPath(home), 'utf8'))
  } catch {
    return null
  }
}
