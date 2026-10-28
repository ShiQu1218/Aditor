use rustfft::{num_complex::Complex64 as Complex, Fft, FftDirection, FftPlanner};
use std::{cell::RefCell, collections::VecDeque, sync::Arc};
thread_local! {static PLANNER: RefCell<FftPlanner<f64>> = RefCell::new(FftPlanner::new());}
fn plan(n: usize, inverse: bool) -> Arc<dyn Fft<f64>> {
    PLANNER.with(|p| {
        p.borrow_mut().plan_fft(
            n,
            if inverse {
                FftDirection::Inverse
            } else {
                FftDirection::Forward
            },
        )
    })
}
fn transpose(a: &[Complex], b: &mut [Complex], w: usize, h: usize) {
    for y0 in (0..h).step_by(16) {
        for x0 in (0..w / 2 + 1).step_by(16) {
            for y in y0..(y0 + 16).min(h) {
                for x in x0..(x0 + 16).min(w / 2 + 1) {
                    b[x * h + y] = a[y * w + x];
                }
            }
        }
    }
}
fn transform(a: &mut Vec<Complex>, w: usize, h: usize) {
    let pw = plan(w, false);
    let ph = plan(h, false);
    let mut scratch = vec![
        Complex::default();
        pw.get_inplace_scratch_len()
            .max(ph.get_inplace_scratch_len())
    ];
    pw.process_with_scratch(a, &mut scratch);
    let mut transposed = vec![Complex::default(); (w / 2 + 1) * h];
    transpose(a, &mut transposed, w, h);
    ph.process_with_scratch(&mut transposed, &mut scratch);
    *a = transposed;
}
#[derive(PartialEq, Eq, Clone, Copy)]
struct Key {
    hash: u64,
    width: usize,
    height: usize,
    w: usize,
    h: usize,
}
type Spectrum = (Key, Arc<Vec<f64>>, Arc<Vec<Complex>>);
thread_local! {static SPECTRA:RefCell<VecDeque<Spectrum>>=const{RefCell::new(VecDeque::new())};}
fn spectrum(
    data: &Arc<Vec<f64>>,
    width: usize,
    height: usize,
    w: usize,
    h: usize,
) -> Arc<Vec<Complex>> {
    SPECTRA.with(|cache| {
        let mut cache = cache.borrow_mut();
        let shared = cache.iter().position(|(k, values, _)| {
            k.width == width
                && k.height == height
                && k.w == w
                && k.h == h
                && Arc::ptr_eq(values, data)
        });
        let hash = if let Some(i) = shared {
            cache[i].0.hash
        } else {
            data.iter().fold(0xcbf29ce484222325u64, |hash, v| {
                (hash ^ v.to_bits()).wrapping_mul(0x100000001b3)
            })
        };
        let key = Key {
            hash,
            width,
            height,
            w,
            h,
        };
        if let Some(i) = shared.or_else(|| {
            cache
                .iter()
                .position(|(k, values, _)| *k == key && values == data)
        }) {
            let entry = cache.remove(i).unwrap();
            let out = entry.2.clone();
            cache.push_back(entry);
            return out;
        }
        let mut a = vec![Complex::default(); w * h];
        for y in 0..height {
            for x in 0..width {
                a[y * w + x].re = data[y * width + x];
            }
        }
        transform(&mut a, w, h);
        let a = Arc::new(a);
        while cache.len() >= 40
            || cache.iter().map(|(_, _, v)| v.len() * 16).sum::<usize>() + a.len() * 16
                > 48 * 1024 * 1024
        {
            if cache.pop_front().is_none() {
                break;
            }
        }
        cache.push_back((key, data.clone(), a.clone()));
        a
    })
}
pub(super) fn correlate(
    source: &Arc<Vec<f64>>,
    sw: usize,
    sh: usize,
    template: &Arc<Vec<f64>>,
    tw: usize,
    th: usize,
) -> Vec<f64> {
    let w = sw.next_power_of_two();
    let h = sh.next_power_of_two();
    let a = spectrum(source, sw, sh, w, h);
    let b = spectrum(template, tw, th, w, h);
    let width = sw - tw + 1;
    let height = sh - th + 1;
    // Real correlation is Hermitian; transform half the columns and pack two real rows per FFT.
    let columns = w / 2 + 1;
    let mut vertical: Vec<_> = a.iter().zip(b.iter()).map(|(a, b)| *a * b.conj()).collect();
    let ph = plan(h, true);
    let pw = plan(w, true);
    let mut scratch = vec![
        Complex::default();
        ph.get_inplace_scratch_len()
            .max(pw.get_inplace_scratch_len())
    ];
    ph.process_with_scratch(&mut vertical, &mut scratch);
    let mut rows = vec![Complex::default(); height.div_ceil(2) * w];
    for (pair, row) in rows.chunks_exact_mut(w).enumerate() {
        let y = pair * 2;
        for x in 0..columns {
            let a = vertical[x * h + y];
            let b = if y + 1 < height {
                vertical[x * h + y + 1]
            } else {
                Complex::default()
            };
            row[x] = Complex::new(a.re - b.im, a.im + b.re);
            if x > 0 && x < w - x {
                row[w - x] = Complex::new(a.re + b.im, -a.im + b.re);
            }
        }
    }
    pw.process_with_scratch(&mut rows, &mut scratch);
    let scale = 1. / (w * h) as f64;
    let mut values = vec![0.; width * height];
    for y in 0..height {
        for x in 0..width {
            let v = rows[(y / 2) * w + x];
            values[y * width + x] = if y % 2 == 0 {
                v.re * scale
            } else {
                v.im * scale
            };
        }
    }
    values
}
#[cfg(test)]
mod tests {
    #[test]
    fn correlation_handles_single_rows_columns_and_full_templates() {
        for (sw, sh, tw, th) in [
            (1, 17, 1, 5),
            (19, 1, 7, 1),
            (1, 1, 1, 1),
            (13, 9, 13, 9),
            (16, 8, 3, 2),
        ] {
            let src: Vec<_> = (0..sw * sh)
                .map(|i| ((i * 71) % 257) as f64 - 128.)
                .collect();
            let tpl: Vec<_> = (0..tw * th)
                .map(|i| ((i * 31) % 101) as f64 - 50.)
                .collect();
            let src = std::sync::Arc::new(src);
            let tpl = std::sync::Arc::new(tpl);
            let actual = super::correlate(&src, sw, sh, &tpl, tw, th);
            let width = sw - tw + 1;
            for y in 0..=sh - th {
                for x in 0..width {
                    let mut expected = 0.;
                    for ty in 0..th {
                        for tx in 0..tw {
                            expected += src[(y + ty) * sw + x + tx] * tpl[ty * tw + tx];
                        }
                    }
                    assert!((actual[y * width + x] - expected).abs() < 1e-6);
                }
            }
        }
    }

    #[test]
    fn correlation_matches_direct_on_nonconstant_data() {
        let src: Vec<_> = (0..33 * 17).map(|i| ((i * 71) % 257) as f64).collect();
        let t: Vec<_> = (0..7 * 5).map(|i| ((i * 31) % 101) as f64).collect();
        let src = std::sync::Arc::new(src);
        let t = std::sync::Arc::new(t);
        let r = super::correlate(&src, 33, 17, &t, 7, 5);
        for y in 0..13 {
            for x in 0..27 {
                let mut exact = 0.;
                for yy in 0..5 {
                    for xx in 0..7 {
                        exact += src[(y + yy) * 33 + x + xx] * t[yy * 7 + xx];
                    }
                }
                assert!((r[y * 27 + x] - exact).abs() < 1e-6);
            }
        }
    }
}
