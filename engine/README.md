# Rust analysis engine

`aditor` is an edition-2021 Cargo binary, launched as a separate process by
Electron. Production commands are `ipc` (JSON Lines), `live` (shared-memory input,
JSON Lines), `analyze --out FILE`, and `matches` (JSON). No Python runtime is needed.

```powershell
$env:CARGO_BUILD_JOBS = '4'
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test -- --test-threads=4
cargo build --release
```

FFmpeg lookup preserves environment override, `ADITOR_FFMPEG` sibling, bundled
`ffmpeg/` (including `bin/`), then PATH order. Electron sets the packaged FFmpeg override to
`resources/ffmpeg/bin/ffmpeg.exe`; ffprobe resolves from its sibling directory
unless `ADITOR_FFPROBE` is explicitly set. Development prefers
`target/release/aditor.exe`, falling back to `target/debug/aditor.exe`.
`../scripts/build.ps1 -EngineOnly` rebuilds and stages `build/engine/aditor/aditor.exe`
and checks live shared-memory compatibility without building an installer.

Reference data is frozen in [tests/parity](tests/parity/README.md). Normal Cargo
tests never invoke a Python oracle. Ignored recording tests require
`ADITOR_GOLDEN_VIDEO` or `ADITOR_MATCH_DIR`; run the performance test in release
mode explicitly. Hidden `debug-valorant-feed` / `debug-benchmark` commands support
[maintained Python tools](../tools/README.md), reusing native detection/decoding.

## Known differences and verification limits

- Control feed HUD names, weapons and victims use grayscale contrast and glyphs;
  Traditional Chinese, English and Japanese share the same path without hue rules.
  Legacy confidence scores can change with the grayscale crop bounds; the live reference
  test still checks event identity/timing and bounds confidence to 0.6–1.0.
- Separate knock/assist-knock banners count again after a revive, even for the
  same name within 90 seconds. Elimination deduplication still applies against
  each counted knock. Phase B derives adjust these expectations from the frozen
  Python oracle; continuous banner frames are still merged by the event tracker.
- Malformed JSON/ffprobe fields and invalid arguments can have different diagnostic
  text from the former Python parser. Live errors retain the error code/message/exception envelope but have an
  empty traceback frames array; unexpected live work errors currently use
  `RuntimeError` instead of reproducing every possible Python exception class.
  CLI parser formatting for malformed arguments is not byte-identical to argparse.
- JSON whitespace/key order and integer-versus-float spelling can differ; decoded
  JSON values are the wire contract. CV float outputs allow absolute error below `1e-4`, rather than being
  bit-identical. Invalid overflowing mapped dimensions are checked and rejected
  before allocation rather than relying on Python's arbitrary-size integers.
- Calibration history uses Rust/image PNG encoding rather than OpenCV PNG. Pixels
  round-trip losslessly, but compressed byte sizes can differ, so memory-cap
  degradation may trigger at a different frame for a history exactly at the cap.
- Live polling waits up to 50 ms using a sleep; Python's event wait can wake early
  for stop. Both drain already-written slots and send the final snapshot. Periodic
  output timing/CPU stats and OS-specific I/O error text cannot be byte-identical.
  Native detection has no OpenCV thread pool; its worker is single-threaded.
- Golden recordings and full match acceptance videos are external and were not
  supplied. Their Cargo tests remain explicitly ignored; fixture parity does not
  establish real-recording acceptance. The release performance test is ignored by
  default; its frozen baseline was measured in Phase C. Windows shared-memory behavior was exercised;
  other operating systems are outside this Windows port's verification.


## Pytest to Cargo coverage map

All 32 `test_*.py` modules are accounted for below. Several Python suites share
one Rust reference-replay test; file names and test counts are not one-to-one.
Python monkeypatches of detectors/decoders are represented by frame/trace replay,
native unit checks, or subprocess stubs. Pure Python tool tests remain Python.
Paths below are relative to `engine/`; `src/` entries contain Rust unit tests.

| Python test file | Cargo counterpart / disposition |
| --- | --- |
| `test_analyze.py` | `tests/analyze.rs`, `tests/analyze_parity.rs`, `src/analyze/worker_tests.rs` |
| `test_aspect.py` | `tests/aspect.rs`, `tests/decode_process.rs` |
| `test_autoclip.py` | `tests/phase_b_parity.rs` (16 captured calls, including 3,000 equal-gap events) |
| `test_cache.py` | `tests/cache.rs`, `tests/phase_b_parity.rs` |
| `test_calibrate.py` | `tests/calibrate.rs`, `tests/analyze.rs` |
| `test_colorblind_names.py` | `tests/phase_b_parity.rs::colorblind_name_signatures` (22 crops, all seven checks) |
| `test_control_feed.py` | `tests/control_feed.rs`, `tests/phase_b_parity.rs`, `tests/phase_c_parity.rs` |
| `test_decode.py` | `tests/decode.rs`, `tests/decode_process.rs`, `src/decode.rs` |
| `test_derive.py` | `tests/phase_b_parity.rs` (14 captured calls), `tests/derive.rs`, `src/derive.rs` (decode reuse/LRU bound) |
| `test_diagnostics.py` | `tests/diagnostics.rs`, `tests/ipc.rs`; traceback limitation above |
| `test_evaluate.py` | Not applicable: tests `tools/evaluate.py` metrics/time formatting/truth loading, not engine code; moved to `../tools/tests/` |
| `test_evaluate_valorant.py` | Not applicable: tests `tools/evaluate_valorant.py::match_events`, not engine code; moved to `../tools/tests/` |
| `test_events.py` | `tests/phase_b_parity.rs` (56 captured traces and intermediate snapshots) |
| `test_ffbin.py` | `tests/ffbin.rs` |
| `test_game_detect.py` | `tests/game_detect.rs`, `src/game_detect.rs` |
| `test_games.py` | `tests/games.rs` |
| `test_golden.py` | `tests/analyze.rs::{golden_jobs_one,golden_jobs_auto}`; ignored external-video tests |
| `test_icon_detect.py` | `tests/icon_detect.rs`, `tests/phase_b_parity.rs` |
| `test_ipc.py` | `tests/ipc.rs`, `tests/analyze_parity.rs` |
| `test_keywords.py` | `tests/calibrate.rs`, `tests/phase_b_parity.rs`, `tests/phase_c_audit.rs` |
| `test_late_learning.py` | `tests/calibrate.rs`, `tests/analyze.rs`, `src/analyze/worker_tests.rs`, `src/live/kills_tests.rs` (provisional rejection/replay, offline agreement, caps/logging) |
| `test_layout.py` | `tests/layout.rs`, `tests/module_parity.rs` |
| `test_live.py` | `tests/live.rs`, `src/live/kills_tests.rs`; OpenCV thread-pool check is inapplicable because native detection is single-threaded |
| `test_matches.py` | `tests/matches.rs`, `tests/matches_decode.rs`, `tests/cli.rs`, `tests/phase_c_parity.rs` |
| `test_mixtape.py` | `tests/phase_b_parity.rs`, `tests/phase_c_audit.rs`, `tests/mixtape.rs`, `src/mixtape.rs`, `src/detect/detector_tests.rs` |
| `test_models.py` | `tests/models.rs`, `tests/module_parity.rs` |
| `test_probe.py` | `tests/probe.rs`, `tests/module_parity.rs` |
| `test_profile.py` | `tests/profile.rs`, `tests/module_parity.rs` |
| `test_scene.py` | `tests/scene.rs`, `tests/matches.rs`, `tests/live.rs`; full/lazy score maps replayed on every scene crop |
| `test_segment_ownership.py` | `tests/phase_b_parity.rs` (jobs 1–4 and resumed overlap), `tests/analyze.rs` (interval/partial-cache integration) |
| `test_valorant.py` | `tests/valorant.rs`, `tests/phase_c_parity.rs`, `tests/live.rs`, `tests/game_detect.rs` |
| `test_valorant_rounds.py` | `tests/valorant_rounds.rs`, `tests/valorant.rs` |
