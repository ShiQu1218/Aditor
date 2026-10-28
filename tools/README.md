# Evaluation tools

The production engine is Rust and remains a separate process. Python is needed
only for these tools (Python 3.12 recommended):

```powershell
python -m venv tools/.venv
./tools/.venv/Scripts/python.exe -m pip install -r tools/requirements.txt
cargo build --release --manifest-path engine/Cargo.toml
$env:ADITOR_ENGINE = "$PWD/engine/target/release/aditor.exe"
$env:ADITOR_FFMPEG = "$PWD/build/ffmpeg/bin/ffmpeg.exe"  # from scripts/fetch-ffmpeg.ps1
$env:ADITOR_FFPROBE = "$PWD/build/ffmpeg/bin/ffprobe.exe"
./tools/.venv/Scripts/python.exe -m pytest tools/tests -q
```

`ADITOR_ENGINE` defaults to `engine/target/release/aditor.exe` relative to this
repository, independent of the working directory. Subprocess failures propagate.

- `evaluate.py --truth truth.json --pred cache.json` scores a saved `analyze --out`
  document. Generate it with `aditor analyze VIDEO --profile-dir templates/icons
  --cache-dir CACHE --out cache.json` (use `--game valorant` for Valorant).
- `icon_accept.py --out DIR LAB=VIDEO` invokes `analyze --out`, compares jobs and
  scores events. Baselines are optional via `ICON_ACCEPT_BASELINE`.
- `evaluate_valorant.py` uses the hidden `debug-valorant-feed` JSON Lines command
  to evaluate feed events only, without round highlights or cache writes.
- `benchmark.py VIDEO` uses hidden `debug-benchmark` JSON output for decode and
  per-frame detector timing, excluding calibration/keyframes. `--jobs` launches
  independent segment subprocesses. Timings include startup and vary by hardware.
- Scene results are available directly from `aditor matches VIDEO --timeline`.
- `extract_templates.py` uses `ADITOR_FFMPEG`, then `build/ffmpeg/bin`, then PATH.
- `outplayed_truth.py` reads Outplayed IndexedDB; `check.py` edits plan checkboxes.
  Neither needs an engine import or subprocess.

Archived scripts are unsupported; see [archive/README.md](archive/README.md).
