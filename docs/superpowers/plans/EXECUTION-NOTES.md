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


---

## Plan 3 performance

- **Task 17a bench** (`npm --prefix app run bench` ＝ `vitest bench --run`；檔案 `app/src/renderer/timeline/layout.bench.ts`；不是 CI 失敗門檻)
- **環境**：AMD Ryzen 7 7700、Node v24.16.0、vitest 2.1.9、Windows 11（桌機；低階 4 GB 筆電尚未實測，需要時以同一指令重跑）
- **spec §6 目標**：2000 事件 `layoutTimeline` < 5 ms

| 項目 | mean | p99 | hz |
|---|---|---|---|
| `layoutTimeline` 2004 事件，全片視圖（density） | 0.070 ms | 0.180 ms | 14.3 k/s |
| `layoutTimeline` 2004 事件，放大視圖（icons＋群集） | 0.005 ms | 0.007 ms | 196 k/s |
| `layoutTimeline` 6004 事件，全片視圖（density） | 0.196 ms | 0.282 ms | 5.1 k/s |
| `layoutTimeline` 6004 事件，放大視圖（icons＋群集） | 0.017 ms | 0.024 ms | 59.7 k/s |
| `computeGrid` 500 筆（5 組、scrollTop 0） | 0.0002 ms | 0.0004 ms | 5.8 M/s |
| `computeGrid` 500 筆（捲動到中段） | 0.0002 ms | 0.0004 ms | 5.6 M/s |
| `listWindow` 6000 列、44 px | < 0.0001 ms | 0.0001 ms | 24.9 M/s |

- 結論：所有純函式幾乎免費（2000 事件比目標快約 70 倍）；實際成本在 canvas 繪製與 React 渲染，不在版面計算。
- 低效能模式（`<html data-lowperf>`）：熱度條 60 格、關閉所有 transition／animation、移除 hover 位移；首次啟動偵測無硬體解碼時詢問一次。

## Plan 3 E2E（Task 18）

- 指令：`npm --prefix app run test:e2e`（先 `electron-vite build`，再以 Playwright `_electron` 驅動已安裝的 Electron 33；不下載瀏覽器）。CI 不強制。
- 環境掛鉤：`APEXHL_E2E=1`＋`APEXHL_APPDATA`（暫存 appData／userData）＋`APEXHL_ENGINE=fake`（`app/test/fake-engine.mjs` 的 `FAKE_ENGINE_MODE=e2e`，引擎形狀的 300 筆合成事件、progress／cancel／derive／autoclip）＋`APEXHL_E2E_FAKE_FFMPEG=1`（匯出改用真實子程序 `fake-ffmpeg.mjs`）。缺少 `APEXHL_E2E=1` 時一律無作用（`main/e2e.test.ts` 鎖定）。
- 影片：以系統 ffmpeg 的 `testsrc2`＋靜音 AAC 產生 3 支 12–20 秒 H.264 於暫存目錄；找不到 ffmpeg 時需要影片的案例 `skip` 並印出原因（實測：無 ffmpeg → 4 通過、17 略過、0 失敗）。
- 結果（本機，ffmpeg 8.1.1）：**21 個案例，連跑 3 次皆 21 通過／0 略過／0 失敗**（每次約 47 秒），無 flaky。
- 驗證不是空轉：暫時還原 Ctrl+→ 錨點修正、關閉時 flushSync、手勢 Esc 攔截，對應案例都會失敗（已還原）。
- 仍需人工：真實 AV1／長片與代理檔、真實引擎辨識品質、NVENC／OpenH264 實際編碼、螢幕閱讀器、Windows 高對比、IME、色盲濾鏡、4 GB 低階機效能、真實硬體解碼偵測（E2E 以覆寫 `mediaCapabilities` 模擬）。
