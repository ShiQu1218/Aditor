/**
 * 錄影診斷紀錄：每行附時間並立即 fsync。系統藍屏時一般寫入會留在快取而遺失，
 * 這份紀錄要能事後判斷當機當下錄影器在做什麼；事件量很少，同步寫入的成本可忽略。
 */
import fs from 'fs'

/** 超過這個大小就把舊紀錄改名成 `.old`，只保留一代 */
const MAX_LOG_BYTES = 1024 * 1024

export function createDiagnosticLog(file: string, now: () => Date = () => new Date()): (message: string) => void {
  return (message) => {
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.old`)
      const fd = fs.openSync(file, 'a')
      try {
        fs.writeSync(fd, `${now().toISOString()} ${message.replace(/[\r\n]+/g, ' ')}\n`)
        fs.fsyncSync(fd)
      } finally { fs.closeSync(fd) }
    } catch { /* 診斷紀錄失敗不影響錄影 */ }
  }
}
