use super::Image;
use anyhow::{ensure, Result};
pub fn gray(src: &Image<u8>) -> Result<Image<u8>> {
    ensure!(src.channels == 3, "BGR requires three channels");
    Image::new(
        src.width,
        src.height,
        1,
        src.data
            .chunks_exact(3)
            .map(|p| {
                ((p[0] as u32 * 3735 + p[1] as u32 * 19235 + p[2] as u32 * 9798 + 16384) >> 15)
                    as u8
            })
            .collect(),
    )
}
pub fn hsv(src: &Image<u8>) -> Result<Image<u8>> {
    ensure!(src.channels == 3, "BGR requires three channels");
    let mut out = src.clone();
    for (p, q) in src.data.chunks_exact(3).zip(out.data.chunks_exact_mut(3)) {
        let (b, g, r) = (p[0] as i32, p[1] as i32, p[2] as i32);
        let v = r.max(g).max(b);
        let diff = v - r.min(g).min(b);
        let sdiv = if v == 0 {
            0
        } else {
            (255.0 * 4096.0 / v as f64).round_ties_even() as i32
        };
        let hdiv = if diff == 0 {
            0
        } else {
            (180.0 * 4096.0 / (6 * diff) as f64).round_ties_even() as i32
        };
        let s = (diff * sdiv + 2048) >> 12;
        let raw = if v == r {
            g - b
        } else if v == g {
            b - r + 2 * diff
        } else {
            r - g + 4 * diff
        };
        let h = (raw * hdiv + 2048) >> 12;
        q.copy_from_slice(&[(if h < 0 { h + 180 } else { h }) as u8, s as u8, v as u8]);
    }
    Ok(out)
}
pub fn in_range(src: &Image<u8>, low: &[u8], high: &[u8]) -> Result<Image<u8>> {
    ensure!(
        low.len() == src.channels && high.len() == src.channels,
        "Range channel mismatch"
    );
    Image::new(
        src.width,
        src.height,
        1,
        src.data
            .chunks_exact(src.channels)
            .map(|p| {
                if p.iter()
                    .zip(low)
                    .zip(high)
                    .all(|((&v, &lo), &hi)| v >= lo && v <= hi)
                {
                    255
                } else {
                    0
                }
            })
            .collect(),
    )
}
