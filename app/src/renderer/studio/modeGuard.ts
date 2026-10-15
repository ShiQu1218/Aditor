import type { Command } from '../input/keymap'

/** 會改動「來源文件」（事件、合輯、override）的指令；專案模式下一律忽略。 */
export const SOURCE_EDIT_COMMANDS = ['addEvent', 'supercut', 'deleteSelectedEvents', 'deleteEvent', 'setOverride'] as const
export type SourceEditCommand = (typeof SOURCE_EDIT_COMMANDS)[number]

export function guardCommand(mode: 'source' | 'project', cmd: Command | SourceEditCommand): 'allow' | 'blocked' {
  return mode === 'project' && (SOURCE_EDIT_COMMANDS as readonly string[]).includes(cmd) ? 'blocked' : 'allow'
}
