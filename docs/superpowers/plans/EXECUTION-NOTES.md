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

### Task 1: 專案骨架與引擎用戶端
- **Status**: Completed (commit `4d125b3`)
- **Vitest**: 8 passed (EngineClient unit tests + real Python engine integration)

### Task 2: 影片庫與分析佇列
- **Status**: Completed (commit `b44510b`)
- **Vitest**: 14 passed (Library deduplication/filtering/search + AnalysisQueue single-worker/error-resilience/counts)
- **Manual GUI check TODO**: In desktop UI, verify visually importing 5 Exports videos from `E:\Outplayed\Outplayed\Exports` displays knock/assist badges on cards and progress bar while analyzing. (Automated tests verify library and queue behavior).

### Task 3: 時間軸與片段的純函式模型
- **Status**: Completed (commit `0a0ec9a`)
- **Vitest**: 26 passed (time conversions, formatTime, timeline zoom/pan/heatmap/hitTest/nextEvent, clip creation/resize/supercut/merging)

### Task 4: 檢視器畫面
- **Status**: Completed
- **Vitest**: 32 passed (viewer state reducer, event corrections retention, clip replacements, time utilities)
- **Manual GUI check TODO**: In desktop UI, open an Exports video in Viewer, verify clicking event marker seeks to ~8 seconds before event, AI autoclip dialog produces clips, and deleting an event persists across reopen. (Automated tests verify reducer, canvas hit-test, and cache synchronization).



