import type { Command } from '../input/keymap'

/** Commands that modify the source document (events and highlights); always ignore them in project mode. */
export const SOURCE_EDIT_COMMANDS = ['addEvent', 'editClips'] as const
export type SourceEditCommand = (typeof SOURCE_EDIT_COMMANDS)[number]

export function guardCommand(mode: 'source' | 'project', cmd: Command | SourceEditCommand): 'allow' | 'blocked' {
  return mode === 'project' && (SOURCE_EDIT_COMMANDS as readonly string[]).includes(cmd) ? 'blocked' : 'allow'
}
