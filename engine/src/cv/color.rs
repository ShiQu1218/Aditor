use super::Image;
use anyhow::{ensure, Result};
use std::sync::LazyLock;

pub(crate) static HSV_SDIV: LazyLock<[i32; 256]> = LazyLock::new(|| {
    let mut table = [0; 256];
    for (v, entry) in table.iter_mut().enumerate().skip(1) {
        *entry = (255.0 * 4096.0 / v as f64).round_ties_even() as i32;
    }
    table
});
static HSV_HDIV: LazyLock<[i32; 256]> = LazyLock::new(|| {
    let mut table = [0; 256];
    for (diff, entry) in table.iter_mut().enumerate().skip(1) {
        *entry = (180.0 * 4096.0 / (6 * diff) as f64).round_ties_even() as i32;
    }
    table
});
pub fn gray(src: &Image<u8>) -> Result<Image<u8>> {
    ensure!(src.channels == 3, "BGR requires three channels");
    Image::new(
        src.width,
        src.height,
        1,
        src.data
            .as_chunks::<3>()
            .0
            .iter()
            .map(|p| {
                ((p[0] as u32 * 3735 + p[1] as u32 * 19235 + p[2] as u32 * 9798 + 16384) >> 15)
                    as u8
            })
            .collect(),
    )
}
pub fn hsv(src: &Image<u8>) -> Result<Image<u8>> {
    ensure!(src.channels == 3, "BGR requires three channels");
    let sdiv_table = &*HSV_SDIV;
    let hdiv_table = &*HSV_HDIV;
    let mut out = src.clone();
    for (p, q) in src
        .data
        .as_chunks::<3>()
        .0
        .iter()
        .zip(out.data.as_chunks_mut::<3>().0.iter_mut())
    {
        let v = p[0].max(p[1]).max(p[2]);
        let diff = v - p[0].min(p[1]).min(p[2]);
        let sdiv = sdiv_table[v as usize];
        let hdiv = hdiv_table[diff as usize];
        let (v, diff) = (v as i32, diff as i32);
        let (b, g, r) = (p[0] as i32, p[1] as i32, p[2] as i32);
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

#[cfg(test)]
pub(crate) fn hsv_reference(src: &Image<u8>) -> Result<Image<u8>> {
    ensure!(src.channels == 3, "BGR requires three channels");
    let mut out = src.clone();
    for (p, q) in src
        .data
        .as_chunks::<3>()
        .0
        .iter()
        .zip(out.data.as_chunks_mut::<3>().0.iter_mut())
    {
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

#[cfg(test)]
pub(crate) fn color_test_image() -> Image<u8> {
    let mut data = Vec::new();
    for b in (0..=255).step_by(15) {
        for g in (0..=255).step_by(15) {
            for r in (0..=255).step_by(15) {
                data.extend_from_slice(&[b, g, r]);
            }
        }
    }
    for v in 0..=255 {
        data.extend_from_slice(&[v, v, v]);
        for low in 0..=v {
            data.extend_from_slice(&[low, low, v]);
        }
    }
    data.extend_from_slice(&[11, 11, 22]);
    let mut seed = 20261106u32;
    for _ in 0..65536 * 3 {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        data.push((seed >> 24) as u8);
    }
    Image::new(data.len() / 3, 1, 3, data).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hsv_matches_reference() {
        let src = color_test_image();
        assert_eq!(hsv(&src).unwrap(), hsv_reference(&src).unwrap());
        for channels in [0, 1, 3, 4] {
            for data in [vec![], vec![11], vec![11, 11], vec![11, 11, 22, 99]] {
                let src = Image {
                    width: 0,
                    height: 1,
                    channels,
                    data,
                };
                match (hsv(&src), hsv_reference(&src)) {
                    (Ok(actual), Ok(expected)) => assert_eq!(actual, expected),
                    (Err(actual), Err(expected)) => {
                        assert_eq!(actual.to_string(), expected.to_string())
                    }
                    results => panic!("Mismatched results: {results:?}"),
                }
            }
        }
    }
}
