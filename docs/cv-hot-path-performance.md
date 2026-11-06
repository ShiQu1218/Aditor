# CV hot-path optimizations (2026-11-06)

Source: items 1-4 of the math/algorithm performance research. All changes are bit-identical: each keeps the
old implementation as a `#[cfg(test)]` reference and compares new vs old on fixed-seed inputs.

Setup: AMD Ryzen 7 7700, release build (`opt-level = 3`, thin LTO), base `6c70ec7`. Benchmarks are
`#[ignore]` tests in `engine/tests/perf_{resize,color,filters}.rs` and `live_performance.rs`. Before (A) and
after (B) binaries were run interleaved A B A B A B, 3 rounds; each BENCH value is itself a median of 9 runs.

| Change | Case | Before (µs, median) | After (µs, median) | Speedup |
|---|---|---:|---:|---:|
| `resize`: quantize u8 linear weights once per row/column | BGR 800x180 x0.75 | 12,703 | 1,121 | 11.3x |
| | BGR 800x180 x1.33 | 40,193 | 3,429 | 11.7x |
| | gray 480x118 x2 | 12,213 | 1,099 | 11.1x |
| | BGR 1920x1080 -> 1280x720 | 146,555 | 12,953 | 11.3x |
| `hsv`: 256-entry division tables | BGR 800x180 | 820 | 609 | 1.35x |
| | BGR 480x118 | 296 | 209 | 1.41x |
| `white_mask`: V and fixed-point S straight from BGR (no H, no HSV image) | 480x118 | 550 | 72 | 7.7x |
| | 800x30 | 137 | 26 | 5.3x |
| `rect_morph`: van Herk/Gil-Werman for kernel length >= 81 | Open 81x1 then 1x5, 800x180 | 633 | 396 | 1.6x |
| | same, 1920x1080 | 11,021 | 4,884 | 2.3x |
| `gaussian_blur`: coefficient quantization hoisted out of the pixel loop | f32 3x3, 480x30 | 157 | 142 | 1.1x |

Unchanged paths (area decimation, f32 resize, small morphology kernels) stayed within noise.

End to end (live detection, `unique_frame_detection_performance`, 200 unique frames, wall ms/frame):
before 16.19 (16.17-16.23), after 15.67 (15.67-15.77), about 3%. Every after-run was faster than every
before-run. The live fixture is 1080p, so the layout ROI resize (11x faster) is not exercised there; it only
runs for non-16:9 sources.

Rejected: masked NCC precompute for scene templates (`classify_frame` 484 -> 479 µs, within noise, +290 lines).

Equivalence: `cargo test` 204 passed / 0 failed (includes `cv_parity`, `module_parity`, `phase_b_parity`,
`phase_c_parity`, `analyze_parity` and the new old-vs-new equality tests); `cargo fmt --check` and
`cargo clippy --all-targets -- -D warnings` clean. Fixtures were not regenerated.

Not measured: full offline `analyze` on a real recording (no gameplay video on this machine), golden-video
accuracy (`ADITOR_GOLDEN_VIDEO` not set), VALORANT match acceptance, energy use.
