# Phase A reference fixtures

`cv/cases.json` contains 887 OpenCV cases. Integer outputs are compared exactly;
float outputs use an absolute tolerance of `1e-4`. Non-finite numbers are encoded
as `"nan"`, `"inf"`, and `"-inf"`. The PNG files are deterministic synthetic images
and small crops from the existing templates and fixtures.

`modules.json` covers probe metadata/keyframes, profile values, layout coordinates,
game resolution, aspect selection, and aspect detection on the existing scene atlases.
`reference.json` records the interpreter, NumPy, and OpenCV versions used to generate them.

## Frozen oracle

The Python oracle was removed in the Phase D commit (this change). The last
Python-engine commit is `c30dddf`; the Phase A-C reference exporters are archived
in `tools/archive/parity/`. Normal Cargo tests replay the checked-in JSON/PNG/video
data without Python. `phase_c/live_{game}_{stop}.json` freezes Python's complete
live streams before removal; only `cpu_ms_per_frame` is ignored in comparison.
`phase_c/performance.json` holds the original three-run Python CPU baseline.

To regenerate, use a separate checkout from git history containing the Python
engine (`c30dddf`) and restore the Phase A-C exporters from this change's parent
history (or copy the archived files back to their original `tools/` locations).
Set `PYTHONPATH` to that checkout's `engine`, install the recorded NumPy/OpenCV
versions, set `ADITOR_FFMPEG` / `ADITOR_FFPROBE`, then run `tools/dump_parity.py`
with `--phase-b`, `--analyze`, `--phase-c`, or `--phase-c-audit` as needed. Generate
live streams with the pre-removal `tests/live.rs` producer and Python command.
Copy only reviewed fixture outputs back; do not regenerate with Rust as oracle.

`phase_b_reference.json` and `phase_c/reference.json` record Python 3.12.14,
NumPy 2.3.5 and OpenCV 5.0.0 (the former now also records the same executable).
Earlier Phase A data used Python 3.12.9 / NumPy 2.3.1. The requested old venv
launcher pointed to an inaccessible installation. See [engine README](../../README.md)
for the pytest-to-Cargo coverage map and known parity differences.
