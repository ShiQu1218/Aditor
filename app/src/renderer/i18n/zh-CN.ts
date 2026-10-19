import type { Messages } from './index'
import { i18n } from './zh-CN/main'
import { liveI18n } from './zh-CN/live'
import { recordingI18n } from './zh-CN/recording'
import { settingsI18n } from './zh-CN/settings'
import { shellI18n } from './zh-CN/shell'

export const zhCN: Messages = { i18n, shellI18n, settingsI18n, recordingI18n, liveI18n }
