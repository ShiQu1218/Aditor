// 「今天／昨天」標籤會在本地午夜後過期：提供距下一個本地午夜的毫秒數，與重新取得現在時間的 hook。
import { useEffect, useState } from 'react'

/** 距下一個本地 00:00 的毫秒數（至少 1，避免 0 ms 的計時器空轉） */
export function msUntilNextLocalMidnight(now: number): number {
  const d = new Date(now)
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
  return Math.max(1, next - now)
}

function dayId(now: number): string {
  const d = new Date(now)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

/** 回傳「目前時間」，並在本地午夜（計時器）與視窗取得焦點時（系統睡眠後計時器可能漏掉）更新；同一天內不變 */
export function useLocalNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = (): void => {
      const t = Date.now()
      setNow((prev) => (dayId(prev) === dayId(t) ? prev : t))
    }
    const schedule = (): void => {
      timer = setTimeout(() => {
        refresh()
        schedule()
      }, msUntilNextLocalMidnight(Date.now()) + 50)
    }
    schedule()
    window.addEventListener('focus', refresh)
    return () => {
      if (timer) clearTimeout(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [])
  return now
}
