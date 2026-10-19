import type { Messages } from './index'
import { i18n } from './en/main'
import { liveI18n } from './en/live'
import { recordingI18n } from './en/recording'
import { settingsI18n } from './en/settings'
import { shellI18n } from './en/shell'

export const en: Messages = { i18n, shellI18n, settingsI18n, recordingI18n, liveI18n }
