use anyhow::{ensure, Result};
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct Stats {
    pub frames: usize,
    pub avg_fps: f64,
    pub p50_ms: f64,
    pub p99_ms: f64,
    pub p999_ms: f64,
    pub low_1pct_fps: f64,
    pub low_01pct_fps: f64,
    pub stutters: usize,
    pub max_ms: f64,
}

pub fn summarize(times: &[f64]) -> Result<Stats> {
    ensure!(!times.is_empty(), "No measured frames");
    ensure!(
        times.iter().all(|t| t.is_finite() && *t > 0.0),
        "Invalid frame interval"
    );
    let mut sorted = times.to_vec();
    sorted.sort_by(f64::total_cmp);
    let percentile = |p: f64| sorted[((sorted.len() as f64 * p).ceil() as usize).max(1) - 1];
    let low = |p: f64| {
        let n = ((sorted.len() as f64 * p).ceil() as usize).max(1);
        1000.0 * n as f64 / sorted[sorted.len() - n..].iter().sum::<f64>()
    };
    let median = percentile(0.5);
    Ok(Stats {
        frames: times.len(),
        avg_fps: 1000.0 * times.len() as f64 / times.iter().sum::<f64>(),
        p50_ms: median,
        p99_ms: percentile(0.99),
        p999_ms: percentile(0.999),
        low_1pct_fps: low(0.01),
        low_01pct_fps: low(0.001),
        stutters: times.iter().filter(|t| **t > 2.0 * median).count(),
        max_ms: *sorted.last().unwrap(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_and_small_samples() {
        let s = summarize(&[10.0; 1000]).unwrap();
        assert_eq!(s.avg_fps, 100.0);
        assert_eq!(s.low_1pct_fps, 100.0);
        assert_eq!(s.low_01pct_fps, 100.0);
        assert_eq!(s.stutters, 0);
        assert_eq!(summarize(&[20.0]).unwrap().p999_ms, 20.0);
    }

    #[test]
    fn tails_use_mean_intervals_and_nearest_rank() {
        let mut times = vec![10.0; 998];
        times.extend([30.0, 70.0]);
        let s = summarize(&times).unwrap();
        assert_eq!(s.p99_ms, 10.0);
        assert_eq!(s.p999_ms, 30.0);
        assert!((s.low_1pct_fps - 1000.0 / 18.0).abs() < 1e-9);
        assert_eq!(s.low_01pct_fps, 1000.0 / 70.0);
        assert_eq!(s.stutters, 2);
        assert_eq!(summarize(&[10.0, 20.0]).unwrap().stutters, 0);
    }

    #[test]
    fn rejects_empty_nonfinite_and_nonpositive() {
        for times in [&[][..], &[0.0], &[-1.0], &[f64::NAN], &[f64::INFINITY]] {
            assert!(summarize(times).is_err());
        }
    }
}
