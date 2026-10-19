//! QPC clock. Video (WGC `SystemRelativeTime`) and audio (WASAPI `QPCPosition`) both use 100 ns units
//! from QueryPerformanceCounter, so all timestamps use 100 ns ticks; 0 is the first session frame.

use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};

/// 1 second = 10_000_000 ticks (100 ns each).
pub const TICKS_PER_SEC: i64 = 10_000_000;

/// Current time in 100 ns ticks, converted from QPC.
pub fn now_ticks() -> i64 {
    let mut count = 0i64;
    let mut freq = 0i64;
    // SAFETY: Both calls only write to the supplied i64 values and never fail on Windows XP or later.
    unsafe {
        let _ = QueryPerformanceCounter(&mut count);
        let _ = QueryPerformanceFrequency(&mut freq);
    }
    qpc_to_ticks(count, freq)
}

/// QPC count → 100 ns ticks (using i128 to avoid overflow).
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
