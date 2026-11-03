# Aditor 更新日誌

## v0.4.4

### 新增與改善

- 啟用錯誤回報時，於本機應用程式資料夾產生隨機 UUID v4 安裝識別碼（`user.id`），用於統計各問題影響的安裝數量（不衍生自硬體、帳號或路徑，仍不收集 IP；未啟用時不建立，關閉錯誤回報時立即刪除；既有已啟用者亦可隨時於「設定」關閉以刪除）。
- 分析引擎、錄影器或即時辨識執行檔缺失或無法啟動時，顯示多語系說明提示並保留安全的系統錯誤碼（`spawn_errno`）。
- 改善錯誤回報分組與診斷：以穩定英文分類歸併子程序錯誤、區分音訊配置錯誤與時間戳缺口、忽略外部強制終止（`0x40010004`、`0xC000013A`），並於解碼失敗、錄影索引讀寫失敗與即時引擎異常結束時附帶去識別化診斷摘要。

### 修正

- 修正追補固定影格率（CFR）影格時未先排空音訊佇列，導致已排隊音訊被靜音覆蓋的問題。
- 改善錄影暫時卡頓後的恢復能力：超過 2 秒的視訊缺口改以稀疏補幀降級、超過 5 秒的音訊缺口改以每次最多 0.5 秒分批補齊靜音；封裝佇列等待上限提高至 10 秒並加上 64 MiB 記憶體上限；編碼連續 5 秒無輸出時發送單次警告，滿 60 秒才判定失敗。
- 音訊裝置開啟失敗或錄影中途失效時，保留時間軸並以靜音填補，同時每秒自動重試原裝置。

### 更新方式

- **0.2.2 至 0.4.3 安裝版**可透過應用程式內的自動更新下載並安裝。
- **0.2.0／0.2.1 安裝版**請手動下載並執行 `Aditor-Setup-0.4.4.exe`。
- **免安裝版**請下載 `Aditor-0.4.4-Portable.exe`。

## v0.4.3

### 新增與改善

- 新增錄影擷取方式的遊戲 FPS 影響標示，協助選擇擷取方式。

### 修正

- 修正錄影啟動與執行期間的音訊遺失：保留麥克風音訊、回報擷取中斷，並在混音器延遲啟動時保留 AAC 仍可接收的音訊。
- 修正多聲道音訊轉成立體聲時，後方與側邊環繞聲道遭丟棄的問題。
- 修正靜音後音訊時間戳、DDA 擷取可見性計時，以及 Riot Client 斷線時誤刪錄影分段的問題。
- 修正遊戲視窗結束時 Hook 擷取的等待行為，以及缺少引擎或錄影器執行檔時重複回報錯誤的問題。

### 更新方式

- 安裝版可透過應用程式內的更新功能下載並安裝。
- 免安裝版請下載 `Aditor-0.4.3-Portable.exe`。

---

# Aditor Changelog

## v0.4.4

### Improvements

- Send a random UUID v4 install ID (`user.id`) stored in the local app data directory when error reporting is enabled so issues show how many installs they affect (not derived from hardware, account or path data, IP addresses are still never collected, never created while disabled, and deleted immediately on opt-out; existing opted-in users can disable error reporting in Settings at any time to delete it).
- Show localized guidance and preserve a safe `spawn_errno` when the analysis engine, recorder or live-detection executable is missing or cannot start.
- Improve telemetry grouping and diagnostics: group child faults by stable English categories, separate audio allocation errors from timestamp gaps, ignore external termination exits (`0x40010004`, `0xC000013A`), and include redacted `stderr` tails or distinct messages for decode, recording-index and live-engine faults.

### Fixes

- Drain queued audio between CFR catch-up frames so queued audio is not overwritten with silence during catch-up.
- Recover bounded recordings after temporary stalls: degrade video gaps over 2 seconds to sparse catch-up frames, fill audio gaps over 5 seconds in 0.5-second chunks, raise the mux queue full timeout to 10 seconds with 64 MiB payload caps, and warn once after 5 seconds of encoder stall before failing at 60 seconds.
- Preserve the audio timeline with silence and retry the audio source every second when an audio device fails to open or drops out during recording.

### Updating

- **0.2.2 through 0.4.3 installs** can download and install this update from within the app.
- **0.2.0/0.2.1 installs** need to download and run `Aditor-Setup-0.4.4.exe` manually.
- **Portable builds**: download `Aditor-0.4.4-Portable.exe`.

## v0.4.3

### Improvements

- Show the measured game FPS impact of recording capture methods to help users choose a method.

### Fixes

- Prevent audio loss during recording startup and capture interruptions; preserve microphone audio, report capture failures, and retain startup audio that AAC can still accept when mixing starts late.
- Preserve rear and side surround channels when downmixing multichannel audio to stereo.
- Fix audio timestamps after silence, DDA capture visibility timing, and accidental deletion of recording segments after a Riot Client disconnect.
- Improve Hook capture shutdown when the game window closes and avoid duplicate error reports when the engine or recorder executable is missing.

### Updating

- Installed builds can download and install this update from within the app.
- For the portable build, download `Aditor-0.4.3-Portable.exe`.
