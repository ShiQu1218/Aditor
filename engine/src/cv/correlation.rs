use rustfft::{num_complex::Complex64 as Complex, Fft, FftDirection, FftPlanner};
use std::{cell::RefCell, collections::VecDeque, sync::Arc};
thread_local! {static PLANNER: RefCell<FftPlanner<f64>> = RefCell::new(FftPlanner::new());}
#[derive(Default)]
struct Workspace {
    spatial: Vec<Complex>,
    vertical: Vec<Complex>,
    rows: Vec<Complex>,
    scratch: Vec<Complex>,
}
thread_local! {static WORKSPACE: RefCell<Workspace> = RefCell::new(Workspace::default());}
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
fn transform(
    a: &mut [Complex],
    transposed: &mut [Complex],
    w: usize,
    h: usize,
    scratch: &mut Vec<Complex>,
) {
    let pw = plan(w, false);
    let ph = plan(h, false);
    scratch.resize(
        pw.get_inplace_scratch_len()
            .max(ph.get_inplace_scratch_len()),
        Complex::default(),
    );
    pw.process_with_scratch(a, scratch);
    transpose(a, transposed, w, h);
    ph.process_with_scratch(transposed, scratch);
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
        // Cached spectra own their output; only disposable FFT input and scratch live in WORKSPACE.
        let a = WORKSPACE.with(|workspace| {
            let mut workspace = workspace.borrow_mut();
            let Workspace {
                spatial, scratch, ..
            } = &mut *workspace;
            spatial.resize(w * h, Complex::default());
            spatial.fill(Complex::default());
            for y in 0..height {
                for x in 0..width {
                    spatial[y * w + x].re = data[y * width + x];
                }
            }
            let mut output = vec![Complex::default(); (w / 2 + 1) * h];
            transform(spatial, &mut output, w, h, scratch);
            output
        });
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
    WORKSPACE.with(|workspace| {
        let mut workspace = workspace.borrow_mut();
        let Workspace {
            vertical,
            rows,
            scratch,
            ..
        } = &mut *workspace;
        vertical.resize(a.len(), Complex::default());
        for ((value, a), b) in vertical.iter_mut().zip(a.iter()).zip(b.iter()) {
            *value = *a * b.conj();
        }
        let ph = plan(h, true);
        let pw = plan(w, true);
        scratch.resize(
            ph.get_inplace_scratch_len()
                .max(pw.get_inplace_scratch_len()),
            Complex::default(),
        );
        ph.process_with_scratch(vertical, scratch);
        rows.resize(height.div_ceil(2) * w, Complex::default());
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
        pw.process_with_scratch(rows, scratch);
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
    })
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_reuse_preserves_cached_spectra_and_handles_size_changes() {
        SPECTRA.with(|cache| cache.borrow_mut().clear());
        WORKSPACE.with(|workspace| *workspace.borrow_mut() = Workspace::default());
        let src = Arc::new((0..33 * 17).map(|i| (i % 251) as f64).collect());
        let tpl = Arc::new((0..7 * 5).map(|i| (i % 19) as f64).collect());
        let first = correlate(&src, 33, 17, &tpl, 7, 5);
        let allocations = WORKSPACE.with(|workspace| {
            let w = workspace.borrow();
            (
                w.spatial.as_ptr(),
                w.vertical.as_ptr(),
                w.rows.as_ptr(),
                w.scratch.as_ptr(),
            )
        });
        assert_eq!(correlate(&src, 33, 17, &tpl, 7, 5), first);
        WORKSPACE.with(|workspace| {
            let w = workspace.borrow();
            assert_eq!(
                (
                    w.spatial.as_ptr(),
                    w.vertical.as_ptr(),
                    w.rows.as_ptr(),
                    w.scratch.as_ptr()
                ),
                allocations
            );
        });
        let saved = SPECTRA.with(|cache| {
            cache
                .borrow()
                .iter()
                .map(|(_, _, spectrum)| (spectrum.clone(), spectrum.as_ref().clone()))
                .collect::<Vec<_>>()
        });
        for (sw, sh, tw, th) in [
            (129, 65, 27, 17),
            (1, 17, 1, 5),
            (19, 1, 7, 1),
            (33, 17, 7, 5),
        ] {
            let src = Arc::new(
                (0..sw * sh)
                    .map(|i| (i % 251) as f64 - 100.)
                    .collect::<Vec<_>>(),
            );
            let tpl = Arc::new(
                (0..tw * th)
                    .map(|i| (i % 19) as f64 - 7.)
                    .collect::<Vec<_>>(),
            );
            let actual = correlate(&src, sw, sh, &tpl, tw, th);
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
        for (spectrum, saved) in saved {
            assert_eq!(spectrum.as_ref(), &saved);
        }
        assert_eq!(correlate(&src, 33, 17, &tpl, 7, 5), first);
    }

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
