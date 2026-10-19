//! QPC 時鐘。影像（WGC `SystemRelativeTime`）與音訊（WASAPI `QPCPosition`）都以 100 ns 為單位、
//! 同源於 QueryPerformanceCounter，所以全部時間戳都用「100 ns tick」表示，0 = session 第一格。

use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};

/// 1 秒 = 10_000_000 tick（100 ns）。
pub const TICKS_PER_SEC: i64 = 10_000_000;

/// 目前時間（100 ns tick，QPC 換算）。
pub fn now_ticks() -> i64 {
    let mut count = 0i64;
    let mut freq = 0i64;
    // SAFETY: 兩個呼叫只寫入提供的 i64；Windows XP 以後永不失敗。
    unsafe {
        let _ = QueryPerformanceCounter(&mut count);
        let _ = QueryPerformanceFrequency(&mut freq);
    }
    qpc_to_ticks(count, freq)
}

/// QPC count → 100 ns tick（以 i128 避免溢位）。
pub fn qpc_to_ticks(count: i64, freq: i64) -> i64 {
    ((count as i128 * TICKS_PER_SEC as i128) / freq as i128) as i64
}

pub fn ticks_to_secs(t: i64) -> f64 {
    t as f64 / TICKS_PER_SEC as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qpc_conversion_handles_10mhz_and_odd_freq() {
        assert_eq!(qpc_to_ticks(12_345, 10_000_000), 12_345);
        assert_eq!(qpc_to_ticks(3_000_000, 3_000_000), TICKS_PER_SEC);
    }

    #[test]
    fn now_is_monotonic() {
        let a = now_ticks();
        let b = now_ticks();
        assert!(b >= a);
    }
}
