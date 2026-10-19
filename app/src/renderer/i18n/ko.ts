import type { Messages } from './index'
import { i18n } from './ko/main'
import { liveI18n } from './ko/live'
import { recordingI18n } from './ko/recording'
import { settingsI18n } from './ko/settings'
import { shellI18n } from './ko/shell'

export const ko: Messages = { i18n, shellI18n, settingsI18n, recordingI18n, liveI18n }
