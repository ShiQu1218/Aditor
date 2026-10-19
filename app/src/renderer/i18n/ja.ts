import type { Messages } from './index'
import { i18n } from './ja/main'
import { liveI18n } from './ja/live'
import { recordingI18n } from './ja/recording'
import { settingsI18n } from './ja/settings'
import { shellI18n } from './ja/shell'

export const ja: Messages = { i18n, shellI18n, settingsI18n, recordingI18n, liveI18n }
