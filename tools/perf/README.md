# Fake-game frame-time benchmark

Windows-only benchmark for comparing Aditor's recorder, live engine, and background
analysis on the same looping Apex footage. It does not launch or modify Apex.
All generated media, isolated application data, and results default to the system
temporary directory. Nothing is committed or uploaded by the harness.

## Prerequisites

- PowerShell 7+, Rust, Node/npm, and Python 3.10+ (standard library only).
- Install the existing application's dependencies with `npm ci` in `app/`.
- Build the real recorder and engine in release mode before using recording scenarios.
  From the repository root, use the project's normal native build prerequisites:

```powershell
$env:PATH = "$PWD/build/ffmpeg/bin;" + $env:PATH
$env:ADITORREC_FFMPEG_DIR = "$PWD/build/ffmpeg/bin"
cargo build --release --manifest-path recorder/Cargo.toml
cargo build --release --manifest-path engine/Cargo.toml
```

- Local Apex footage (passed with `-Source`) and the project's FFmpeg build in
  `build/ffmpeg/bin` (`scripts/fetch-ffmpeg.ps1`). Override `-Ffmpeg` when needed.
- Close existing Aditor, Apex, and Valorant instances before running. The harness refuses to
  run alongside them and never kills unrelated processes. Leave the fake-game
  window visible; do not minimize it or change display settings during a run.
- `hook` requires the project's normal OBS hook files in `build/obs-hook`. Aditor
  can fall back from hook to DDA; the harness records the actual method and fails
  that sample if it differs from an explicitly requested method. Rerun with DDA
  explicitly rather than interpreting a fallback as a hook measurement.

## Run

From the repository root:

```powershell
pwsh -File tools/perf/run-fakegame-bench.ps1 -Source D:/footage/apex.mp4 `
  -ClipStart 216 -ClipSeconds 12 -LoadPasses 6 -Scenarios baseline,record -Repeat 3

# Include analysis; allow enough time after import for actual analysis progress.
pwsh -File tools/perf/run-fakegame-bench.ps1 -Source D:/footage/apex.mp4 `
  -AnalysisSource D:/footage/other-apex.mp4 `
  -Scenarios baseline,record,record_analyze -Repeat 3 `
  -DurationS 90 -WarmupS 10 -AnalyzeAtS 30 `
  -LoadPasses 4 -CaptureMethod wgc -Preset balanced

# Component breakdown (same fixed workload/settings for every scenario).
pwsh -File tools/perf/run-fakegame-bench.ps1 -Source D:/footage/apex.mp4 `
  -Scenarios baseline,app_idle,rec_capture,rec_encode,rec_audio,rec_live,record `
  -Repeat 5 -DurationS 90 -WarmupS 10 -CaptureMethod wgc -Preset speed

# Short pipeline smoke test; unsuitable for performance conclusions.
pwsh -File tools/perf/run-fakegame-bench.ps1 -Source D:/footage/apex.mp4 `
  -Scenarios baseline,record -Repeat 1 -DurationS 10 -WarmupS 2 -CooldownS 2
```

In an existing PowerShell session, `-Scenarios baseline,record` is an array;
the script also accepts the comma-separated string passed by `pwsh -File`.

Important parameters (see `Get-Help tools/perf/run-fakegame-bench.ps1 -Full`
or the script's parameter block for all defaults):

| Parameter | Default | Meaning |
| --- | --- | --- |
| `Source` | required | Loop source (real Apex footage) |
| `ClipStart`, `ClipSeconds` | `0`, `12` | Seconds; pick a range that contains knockdowns so the live engine sees kill-feed events |
| `Size`, `ClipFps` | `1920x1080`, `60` | Predecoded texture dimensions and footage playback rate |
| `Windowed` | empty | Borderless primary monitor by default; e.g. `1280x720` for a fixed client size |
| `LoadPasses` | `0` | Deterministic ALU-heavy full-screen passes per rendered frame; raise it until `baseline` is below the monitor refresh rate (GPU-bound), otherwise recorder costs are hidden by the refresh cap |
| `FpsCap` | `0` | Uncapped; independent of footage playback rate |
| `DurationS`, `WarmupS` | `60`, `5` | Measured duration and excluded warmup after capture/live readiness |
| `AnalyzeAtS` | `30` | Copy trigger relative to measurement start, not process launch |
| `AnalysisSource` | required for `record_analyze` | Fixed background analysis input |
| `CaptureMethod`, `Preset` | `auto`, `speed` | Real Aditor recording settings |
| `Repeat`, `CooldownS` | `3`, `10` | Repetitions and cooldown after each sample |
| `StartTimeoutS`, `FinalizeTimeoutS` | `120`, `120` | Readiness/finalization deadlines |
| `CacheDir`, `ResultsDir` | system temp subdirectories | Persistent predecode cache and per-invocation result parent |
| `Python` | `python` | Python executable |

`ClipSeconds * ClipFps` is rounded to the nearest whole frame (half rounds up).
The cache key includes the absolute source path, source size/mtime, clip range,
dimensions, frame rate, color convention, and FFmpeg path/mtime. An incomplete
decode is never reused. Replace a source file with a changed mtime to invalidate
its cache. The default 720 NV12 frames (1080p, 12 s at 60 fps) require about 2.1 GiB of GPU storage,
plus texture alignment and render targets; larger clips can exceed GPU memory.
The game uploads separate immutable Y and UV textures once, then closes the raw
file. No video decoder, texture upload, or file read runs in its render loop.

## Scenarios and synchronization

- `baseline`: no Aditor process. The same game, textures, warmup, and timeline run.
- `app_idle`: the same fresh minimized app as `record`, with
  `recording.autoRecord=false`. Readiness checks still run before the game starts;
  the harness asserts the recording service remains idle during measurement.
- `rec_capture`: only `aditorrec.exe`, capturing and extracting small frames;
  `encode=null` and `audio=null`.
- `rec_encode`: `rec_capture` plus HEVC video encode, mux, and segment writes;
  `audio=null`.
- `rec_audio`: `rec_encode` plus default system audio and microphone capture/encode.
- `rec_live`: `rec_audio` plus the real `aditor.exe live` shared-memory consumer.
  Direct scenarios use no Electron process and do not require an app build.
- `record`: a fresh `ADITOR_APPDATA` with onboarding complete, automatic Apex
  recording enabled, `autoAnalyze=false`, and `postAnalysis=none`. The real Rust
  live engine runs. All other recording defaults (HEVC, 1080p60, 10 Mbps, system
  audio and microphone enabled) come from the application. Effective recording
  capabilities and settings are retained with the isolated data.
- `record_analyze`: the same recording settings, plus `autoAnalyze=true`. At
  `AnalyzeAtS`, the fixed input is copied into an initially empty watched folder.
  This deliberately includes copy/import work as well as analysis contention.
  A run fails if no positive real analysis progress is observed before game exit.
  The source is not shortened or re-encoded, and each run uses a fresh cache.

For repeats, scenario order is interleaved: baseline, record, baseline, record,
and so on (or A/B/C/A/B/C). The script builds the standalone Cargo crate and the
application with `npm run build` when an app scenario is selected, then uses the installed Electron binary with
the app directory. A small Node helper uses the existing Playwright dependency
and IPC bridge to verify app readiness, recorder capabilities, real engine probe,
active recording, and a running live-engine process. Both `APPDATA` and
`ADITOR_APPDATA` point to the fresh isolated root. `ADITOR_E2E` is explicitly
removed because that mode disables automatic game detection in the current app.
Setting `APPDATA` directly preserves normal startup while isolating all data;
`ADITOR_ENGINE=real` is explicitly used. No app source modification is needed.

Direct scenarios use the release binaries in `recorder/target/release` and
`engine/target/release`, with the selected FFmpeg DLL directory first in the
recorder's PATH. They mirror `session.ts` defaults (including profile capture ROIs,
60 FPS, 1080p, 10 Mbps, cursor, native aspect encoding, audio devices/gains),
and honor `CaptureMethod` and `Preset`. `auto` uses WGC on Windows build 20348+
and DDA on older builds, as in the app. A failed hook start fails the sample;
direct scenarios do not silently retry with DDA. The live engine uses Apex's
`templates/icons` and `templates/scene`; `--aspect` follows the user's Apex video
config, with the same missing/unsupported-config fallback as the app. Apex is
the engine default, so `--game` is omitted. Keep that config unchanged across runs
and ensure its HUD aspect agrees with the source footage. Both children run at
below-normal priority.

After the game's `ready` file, direct scenarios send `hello` and `start` and wait
for both a successful start reply and the `started` notification. `rec_live`
also waits for a stats line with processed frames before releasing the gate.
After game exit they send recorder `stop`, close stdin, then send the live
engine `{"cmd":"stop"}` and close its stdin. Nonzero exits, protocol errors,
early recorder stops, missing nonempty `seg_*.m4s`/`init.mp4`, and shutdown
timeouts fail the run. Remaining owned process trees are terminated on cleanup.
Direct session files stay in `<run>/session`; recorder/live stdout JSON lines,
stderr logs, commands, start request, PIDs, and exit codes stay with metadata.
These scenarios keep raw segments and skip the app's final MP4 joining/import.

The fake game presents while waiting for its start gate, allowing game detection
and capture to start. Only then does warmup begin. Footage resets to frame zero
at measurement start in every scenario. Readiness gates have deadlines; early
window closure, occlusion, recording errors, and missing finalized MP4 outputs
fail the run. On success, the helper waits for the recording service to become
idle, then terminates only its Electron process tree (including recorder, engines,
and FFmpeg). On failure it also terminates its own game. No personal settings or
existing recordings are changed. The isolated data is retained for diagnostics.
Run from a normal interactive desktop: hidden agent/sandbox desktops cannot
produce valid DXGI presentation/capture samples. Application-container ACLs may
also prevent Electron from starting in a restricted environment. Do not disable
Electron's sandbox to turn those failures into benchmark results.

## Manual GPU-load calibration

There is intentionally no utilization controller running during measurement.
For a chosen `FpsCap` (for example 144), run baseline samples with `LoadPasses`
at 0, 1, 2, 4, etc. Watch the rendering adapter's **3D** utilization in Task Manager
or the GPU vendor's tool. Pick a fixed N near the desired baseline utilization
(for example 70–85%) while maintaining the target frame rate. Refine N between
the two nearest candidates. Then hold N, cap, dimensions, power mode, and driver
constant for every scenario and repetition. With an uncapped workload the GPU
can already be saturated at N=0; use a cap if utilization headroom is the goal.
Close the monitoring UI before collecting final results. Do not tune N separately
for recording scenarios: that would change the work being compared.

Each extra pass reads the previous pass's texture; the final shader consumes
the last result at low amplitude to preserve HUD readability. The shader cannot
discard the work as an unused output. Presentation uses flip discard, sync interval
zero, maximum frame latency one, and tearing only when DXGI reports support.
The optional FPS cap requests one-millisecond Windows timer resolution and
restores it on exit; it remains subject to normal scheduler jitter.

## Results and statistics

Each invocation prints its result path and creates:

```text
<timestamp-id>/
  r5apex.exe
  001-baseline/
    frames.csv
    stats.json
    metadata.json
    config.json
    measurement.json
    game.stderr.log
    appdata/               # settings, diagnostics, caches for recording scenarios
    recordings/            # finalized recordings
    watched/               # analysis copy, if requested
    app.log                # recording scenarios only
    app-state.jsonl        # timestamped recording/queue/live state
  002-record/...
  summary.md
```

Metadata includes the actual D3D rendering adapter and driver,
requested/actual capture method, effective settings, preset, clip cache identity, Git revision, run order, launch arguments,
timing, recording status/output paths, and analysis-copy/progress timestamps.
Application diagnostics in `appdata/Aditor` record capture selection/fallback.
Do not merge results from different invocations with different configurations.

Frame CSV timestamps use QPC milliseconds at each Present call; frame intervals
are differences between consecutive measured Present timestamps. Warmup intervals
and the first incomplete measurement interval are excluded. Stats are emitted as
one JSON line at game exit. Average FPS is 1000 / mean interval. Percentiles use
nearest rank (including p50). The 1% and 0.1% lows are 1000 / mean of the slowest
ceil(N*0.01) and ceil(N*0.001) intervals, respectively. Stutters are strictly
greater than twice p50; `max_ms` is the longest measured interval. Very short
samples have unstable tail metrics; the 0.1% low can be just one frame.

`background_frames` counts measured frames presented while another window had the
foreground. The fake game reclaims the foreground every 250 ms (and logs the pid
that held it to `game.stderr.log`), because an unfocused window can be throttled by
the driver's background frame-rate limit (seen as a flat 120 FPS at 240 Hz).
The summary automatically excludes any run where it is non-zero.

`summary.md` reports the median and min/max across completed repetitions, FPS
percentage deltas versus the baseline median, and absolute stutter-count deltas.
When all seven breakdown scenarios are present, it also reports a component
breakdown for average FPS, 1% low, and 0.1% low. For each metric, let `B`, `I`,
`C`, `E`, `A`, `L`, and `R` be the respective medians for baseline, app_idle,
rec_capture, rec_encode, rec_audio, rec_live, and record:

| Component | Signed FPS delta |
| --- | --- |
| Electron app | `I - B` |
| Capture + small frames | `C - B` |
| Video encode/mux/writes | `E - C` |
| Audio capture/encode | `A - E` |
| Live engine | `L - A` |
| Unexplained remainder | `R - L - (I - B)` |

Negative deltas mean reduced FPS. Each share is `delta / (R - B) * 100`, so a
cost normally has a positive share. Gains/negative shares are retained; a zero
total drop produces `n/a`. Deltas from medians of few runs are noisy, especially
for tail metrics. Components can interact, so shares are approximate and can
exceed 100%. The remainder includes app integration and any lifecycle differences;
it is not proof of a separate isolated cost. Do not subtract scenario percentages.

Failed runs are excluded; the harness stops on the first failure and preserves
its metadata/logs. To summarize completed runs in a partially failed invocation:

```powershell
python tools/perf/summarize.py '<result-directory>'
```

Run the standalone game without Aditor after a harness run has populated the cache:

```powershell
tools/fakegame/target/release/fakegame.exe --raw '<cache-file>.nv12' `
  --duration-s 10 --warmup-s 2 --load-passes 2 --csv '<outside-repo>/frames.csv'
```

## Verification and limits

```powershell
$env:PATH = "$PWD/build/ffmpeg/bin;" + $env:PATH
$env:ADITORREC_FFMPEG_DIR = "$PWD/build/ffmpeg/bin"
Push-Location tools/fakegame
cargo build --release
cargo test
cargo clippy -- -D warnings
Pop-Location
python tools/perf/summarize.py --self-test
node tools/perf/bench-app.cjs --self-test
node tools/perf/bench-recorder.cjs --self-test
```

This workload has no real game CPU threads, simulation, asset streaming, input,
audio, or GPU geometry load. Its frame times measure Present submission intervals,
not physical display scan-out, input latency, or GPU execution time. Desktop
composition, occlusion, refresh rate, VRR, thermal/power behavior, microphone and
audio availability, CPU scheduling, storage contention, and adapter choice affect
results. The benchmark fails on reported DXGI occlusion, but that does not detect
every possible overlay or partial obstruction. DDA captures the desktop, so keep
other windows off the game. WGC and hook have different costs. The displayed loop
is real recorded footage, not a game simulation; repeated HUD events and abrupt
loop boundaries can affect live detection. Compare Aditor components under fixed
conditions; **do not predict real Apex FPS**. Short smoke results only verify that
the pipeline runs. For useful comparisons use longer runs and several repetitions.

Results retain the full analysis input, recordings, and isolated app caches. They
can consume substantial disk space and may contain footage or local paths. Review
before sharing; remove only the invocation/cache directories you no longer need.

## Reference results (2026-10-28)

RTX 5080, driver 32.0.16.2101, Windows 11, 3840x2160 240 Hz primary monitor; a 12 s
Apex clip with two knockdowns, `-LoadPasses 6` (GPU-bound, baseline ~176.6 FPS),
`-Preset speed`, HEVC 1080p60. Medians, 30 s samples; deltas versus baseline.

| Scenario | Runs | Average FPS | 1% low | 0.1% low |
| --- | ---: | ---: | ---: | ---: |
| `rec_capture` (WGC) | 5 | -3.3% | -3.9% | -4.3% |
| `rec_encode` | 5 | -4.1% | -5.4% | -7.1% |
| `record`, WGC | 5 | -3.7% | -4.3% | -4.7% |
| `record`, DDA | 4 | -6.4% | -11.5% | -20.7% |
| `record_analyze`, WGC | 3 | -5.8% | -16.5% | -23.6% |

Capture plus small-frame extraction accounted for roughly 80-90% of the recording
cost and encode/mux/writes for the rest; the Electron app, audio, and the live
engine were within run-to-run noise. Background analysis during play was the
largest tail-latency cost. These numbers compare Aditor components on one machine;
they do not predict real Apex frame rates.
