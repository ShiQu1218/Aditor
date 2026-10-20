# Recording resource monitor

Start Aditor, then run this from the repository root in Windows PowerShell 5.1 or PowerShell 7:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\monitor-resources.ps1 -GpuCounters
```

Start and stop recording normally in Aditor. Press Ctrl+C in the monitor terminal when finished. The monitor only observes processes; it does not control recording or automatically detect recording boundaries. Sampling before recording also gives an idle baseline.

- `-IntervalSeconds 2`: sample every two seconds (default: one second, subject to collection time).
- `-DurationSeconds 300`: stop after approximately five minutes (default: until Ctrl+C or the app exits).
- `-ProcessId 1234`: select the main Aditor/Electron PID when multiple instances are open or automatic discovery fails. Child processes are included automatically, including newly started recorder/analysis processes. Development mode recognizes this checkout's Electron executable.
- `-OutputDir D:\Measurements\session1`: choose an output folder. Existing CSV files are never overwritten.
- `-GpuCounters`: collect optional Windows GPU engine counters. Unsupported counters produce a warning and monitoring continues. Without available counters GPU fields are blank.

Results default to `out/resource-monitor/<timestamp>-<unique-id>/` (ignored by Git):

- `totals.csv`: one aggregate row per sample.
- `processes.csv`: one row per process per sample, identified by PID and executable name. Executable paths and command lines are not written to the CSV.

CPU is normalized to the whole machine: 100% means all logical processors are busy. CPU and I/O rates are blank for a process's first sample; newly started processes only contribute rates after their second sample. Processes that start and exit between samples cannot be measured.

`WorkingSetMiB` includes shared resident pages, so its sum can double-count shared memory. `PrivateMiB` measures private committed memory, including pages that may not be resident. I/O rates include cached/file/device I/O and are **not physical disk throughput**.

GPU values sum the selected processes' engine utilization across adapters/engines. `GpuEncodeSumPercent` includes VideoEncode engines only; `GpuEngineSumPercent` includes all engine types. These sums can exceed 100% and do not represent an overall GPU usage percentage. GPU memory, temperature, power and game FPS are not collected. Windows/driver counter availability and update timing vary.

OBS mode uses an independently running OBS process, which is outside Aditor's process tree and excluded. To measure OBS separately, run a second monitor with its PID and a different output directory. The monitoring queries themselves have some overhead; increase the interval if needed.

## Memory growth screening

With Aditor running, collect an hour of samples and automatically analyze them:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\test-memory-leak.ps1
```

This samples every five seconds without GPU counters. Use `-ProcessId` to select an instance, `-DurationSeconds` to change the duration, or `-OutputDir` for a new session folder. Recording remains under your control. For a useful test, repeat similar recording/stop/idle cycles at least three times, leaving a few minutes idle between cycles. Keep recording settings and other workload consistent. The script does not automatically control or label these phases. If Ctrl+C interrupts analysis too, analyze the saved session separately:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\test-memory-leak.ps1 -InputDir "D:\Develop\Aditor\out\resource-monitor\SESSION"
```

The terminal prints results and a uniquely named `memory-leak-<id>.json` is saved beside the original CSV. Original samples and previous reports are preserved. The script requires only Windows PowerShell 5.1 or PowerShell 7.

- `SuspectedLeak`: sustained private committed memory growth meets all screening thresholds. Investigate the listed process; this is not proof of a leak.
- `NoSustainedGrowthDetected`: none of the eligible process segments meets all thresholds. Slow, intermittent, short-lived-process and GPU-memory leaks can still be missed.
- `InsufficientData`: no process has sufficient continuous data. The default requires at least five minutes of warmup plus twenty minutes of observations, with at least twenty usable minute windows. Short-lived/insufficient segments remain listed even when other segments are evaluated.

The analysis excludes the first `-WarmupMinutes 5` of each observed process segment and uses minute medians of `PrivateMiB`. A usable minute needs at least three samples spanning forty seconds. Gaps longer than three times the median sample interval (minimum thirty seconds) start a separate segment, with a new warmup. New monitor CSVs include `ProcessStartedAt` to distinguish reused PIDs; legacy CSVs are supported with an identity warning.

A suspect must meet all of: at least `-GrowthMiB 32` between medians of the first/last three minute windows, fitted growth of at least `-SlopeMiBPerMinute 1`, a second-half slope at least half that threshold, and growth greater than 0.1 MiB in at least 70% of adjacent minute windows. Thresholds are screening choices, not universal definitions of a leak. No garbage collection or working-set trimming is forced. Cache growth and changing workloads can still produce positives; confirm retained growth across equivalent cycles and use heap/allocation traces to identify the cause.

Regression fixtures (stable, warmup, plateau, spike, reclamation, sustained growth, process restart, gaps and invalid input):

```powershell
python -m unittest discover -s scripts/tests -p test_memory_leak.py
```
