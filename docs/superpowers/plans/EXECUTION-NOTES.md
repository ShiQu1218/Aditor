# Apex Highlighter — Execution Notes & Decisions

## Plan 1 Task 11: Completion & Accuracy Report

- **Status**: Completed (commit `85fcff9`)
- **Pytest result**: 130 passed, 2 skipped, 1 xfailed
- **Golden test**: 1 passed (12/12 events matched)
- **Accuracy evaluation**:
  - Outplayed truth export (5 clips in `Exports/`): knock recall 100% (8/8), precision 100% (11/11 visually verified; the 3 unaligned cases at Project 60 10.50s, Project 64 5.75s, Project 66 28.00s are genuine on-screen knock banners that Outplayed labeled as kills or truncated).
  - Long recordings: `Apex Legends_10-13-2026_16-45-41-533.mp4` (8240.5s) and `Apex Legends_10-13-2026_18-26-50-167.mp4` (6002.2s) successfully analyzed and keyframes extracted.
- **Speed benchmarks (`tools/benchmark.py`)**:
  - `-hwaccel auto`: 4.46x realtime (600.2s video in 134.7s wall time, 0.2s startup)
  - 軟體解碼 (CPU dav1d): 4.55x realtime (600.2s video in 132.0s wall time, 0.1s startup)
- **Tuning ruling**: Existing thresholds in `templates/zh-TW/profile.json` (knock 0.6, damage 0.65, name_sig 0.32, dedupe 90s) achieved 100% precision and recall; no changes needed; `templates_version` remains `zh-TW@1`.

---

## Plan 2: Electron Application Implementation Log

(Tasks 1–8 will be logged sequentially below.)
