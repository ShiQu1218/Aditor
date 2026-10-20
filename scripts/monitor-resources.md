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
