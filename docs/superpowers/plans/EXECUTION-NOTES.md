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

### Task 5: 播放相容性檢查與代理檔
- **Status**: Completed
- **Vitest**: 38 passed (container & codec checks, MediaCapabilities wrapper, proxy args generation with 960x540 and -g 30, encoder priority selection)
- **Manual GUI check TODO**: In desktop UI, open an AV1 or unsupported format video to see the "建議產生代理檔" banner; click to generate proxy and verify playback seamlessly switches to the proxy file while keeping timeline times unchanged.

### Task 6: 剪輯專案
- **Status**: Completed
- **Vitest**: 49 passed (pure project manipulation: split, move, duplicate, trimItem, totalDuration, History undo/redo/limit stack)
- **Manual GUI check TODO**: In desktop UI, select clips in Viewer and press Ctrl+E to navigate to Editor; verify sequential preview player smoothly switches segments, split cuts at current time, trim adjusts start/end, and Ctrl+Z/Y undos/redos operations.

### Task 7: 匯出
- **Status**: Completed
- **Vitest**: 58 passed (extraSecondsForCopy, concatCompatibility check, copy/precise ffmpeg job generation, encoder priority, escapeConcatPath, disk space verification)
- **Manual GUI check TODO**: In desktop UI, export clips from an Exports video in both "每段各一檔（快速無損）" and "合輯（精準）" modes, verifying output files exist and match expected duration via ffprobe.

### Task 8: 打包、授權與說明文件
- **Status**: Completed
- **LGPL FFmpeg**: BtbN master Windows 64-bit shared LGPL build downloaded and verified with `ffmpeg -buildconf` (no `--enable-gpl`, no `--enable-nonfree`, includes `--enable-libdav1d`).
- **Engine Packaging**: PyInstaller one-dir build produces standalone `apexhl.exe` in `build/engine/apexhl/`. Tested and verified execution in a sanitized environment with no Python and no FFmpeg in PATH.
- **Electron Packaging**: `scripts/build.ps1` runs end-to-end build producing `dist/Apex Highlighter Setup 0.1.0.exe` (NSIS installer, 178.4 MB) and `dist/Apex Highlighter 0.1.0.exe` (portable, 178.2 MB).
- **Licenses & Documentation**: `LICENSE` (MIT), `THIRD_PARTY_NOTICES.md` (FFmpeg LGPL replacement rights, dav1d, OpenCV, NumPy, Cisco OpenH264), `README.md` (features, requirements, build steps, usage).

---

## Final Project Summary

### 1. Tasks Completion Status
- **Plan 1 (Engine)**: Tasks 1 through 11 **ALL COMPLETED**
  - Task 1: Environment & golden fixtures
  - Task 2: Video probe
  - Task 3: Frame decoding (hwaccel & dav1d)
  - Task 4: Template matching & resolution scaling
  - Task 5: Event state machine & calibration
  - Task 6: Spectator detection & teammate veto
  - Task 7: Cache storage (.json)
  - Task 8: Event derivation & manual overrides
  - Task 9: AI Auto-clip clustering
  - Task 10: JSON Lines IPC daemon
  - Task 11: Accuracy evaluation report (`docs/accuracy-report.md`) & benchmarks
- **Plan 2 (App)**: Tasks 1 through 8 **ALL COMPLETED**
  - Task 1: Electron scaffold & IPC client (`EngineClient`)
  - Task 2: Video library, folder watch & analysis queue
  - Task 3: Pure timeline & clip models
  - Task 4: Viewer UI with canvas, corrections & auto clip
  - Task 5: Media playability check & proxy transcoding
  - Task 6: Project editor with sequence timeline & undo/redo
  - Task 7: Export engine with stream copy / precise modes & encoder discovery
  - Task 8: PyInstaller engine, LGPL FFmpeg bundling, electron-builder packaging & licensing

### 2. Test Results
- **Engine pytest suite**: `130 passed, 2 skipped, 1 xfailed in 54.14s`
- **Engine golden accuracy test**: `1 passed` (12/12 events matched)
- **App vitest suite**: `14 passed (14 test files, 58 unit and integration tests passed in 1.06s)`
- **Isolated standalone test**: Verified `apexhl.exe` runs `analyze` in a clean environment with no Python and no FFmpeg in `PATH`.

### 3. Key Accuracy & Performance Metrics
- **Knockdown Recall**: 100% (8/8 on ground-truth clips)
- **Visual Precision**: 100% (11/11 verified visual on-screen knock banners)
- **Spectator Filtering**: 14 teammate knockdowns successfully vetoed during spectator mode in long recordings.
- **Decoding & Analysis Speed**:
  - `-hwaccel auto`: 4.46x realtime (600.2s video in 134.7s)
  - Software decoding (CPU dav1d): 4.55x realtime (600.2s video in 132.0s)

### 4. Known Issues & Manual Verification Items
- **Windows Developer Mode / Symlinks**: Building `winCodeSign` during packaging requires Windows Developer Mode or elevated privileges for macOS symlinks in 7z archives; pre-extracted cache in `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0` bypasses this seamlessly.
- **Manual GUI checks recorded for user**:
  - Library: Verify video cards show badges and analysis progress.
  - Viewer: Verify canvas seek to 8s before event and manual event corrections persist across reopens.
  - Proxy: Verify proxy suggestion banner appears for AV1 and generates 960x540 proxy.
  - Editor: Verify sequential playback across items, splitting, and undo/redo.
  - Export: Verify export outputs play correctly in external players.

