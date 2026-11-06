# Aditor 更新日誌

## v0.4.5

### 新增與改善

- **分析引擎影像運算加速**：縮放、HSV、白色遮罩與長核形態學運算改為位元層級等價的更快實作。非 16:9 來源的縮放（1080p 縮至 720p）由 146.6 毫秒降至 13.0 毫秒（11.3 倍）；480×118 白色遮罩由 550 微秒降至 72 微秒（7.7 倍）；長核形態學由 11.0 毫秒降至 4.9 毫秒（2.3 倍）。1080p 即時偵測每影格約快 3%（16.19 → 15.67 毫秒）。
- **觀戰畫面與分析前置加速**：
  - 觀戰影格不再執行會被丟棄的 Mixtape 偵測並預先準備樣板，觀戰影格偵測由 21.99 毫秒降至 5.26 毫秒（4.2 倍），一般影格約快 4.7%。
  - 平行分析的分段改為平衡「實際解碼長度」：226 秒影片最長解碼段由 88.5 秒降至 80.6 秒（−9%），整體分析中位數 22.18 → 21.66 秒。
  - 未帶遊戲標籤的影片（匯入檔）其遊戲與畫面比例取樣改在同一解碼視窗內完成：前置階段由 4.38 秒降至 3.64 秒（−17%），整體分析 14.86 → 14.17 秒（−4.7%）。取樣影格逐位元相同，分析結果與修改前一致。
- **錄影器喚醒次數降低**：音訊混音迴圈由每秒 271 次喚醒降至 98 次，WGC 管理迴圈由每秒 9.0 次降至 0.99 次，讓筆電在錄影時 CPU 更容易進入深層閒置。
- **遊戲偵測更省電**：遊戲未執行時改為針對各遊戲的篩選查詢（約 31 毫秒），不再每 3 秒列出全部行程（約 500 毫秒 CPU，約佔單一核心 16.7%）；遊戲執行中以輕量存活檢查取代，並每 30 秒完整比對一次以防範 PID 重用。
- **匯入與編輯器儲存加速**：內容未變的資料庫更新不再重寫並同步整份資料庫，也不再廣播更新。500 筆資料庫中，500 次未變更狀態更新由 1,350.6 毫秒降至 281.2 毫秒，100 次未變更精華更新由 206.6 毫秒降至 9.6 毫秒。

### 修正

- **錄影啟動不再執行編碼器探測**：錄影啟動時不再對每張 GPU 的每個編碼器做試編碼與音訊裝置列舉。先前在負載高的 Intel Arc 機器上，該探測會於 30 秒期限內在不同階段逾時，導致錄影重試持續失敗。
- **監看失敗後可自動恢復**：資料夾監看器失敗後會重新建立；Studio 相關 Hook 補齊遺漏的相依項目，避免使用過時狀態。
- **錯誤回報涵蓋已攔截的錄影服務失敗**：已被攔截處理的錄影服務失敗現在也會回報，協助診斷。

### 已知限制

- 效能數據來自本機基準測試（AMD Ryzen 7 7700 與負載不一的開發機），不代表所有硬體；分析整體加速幅度僅約 2% 至 5%。
- 遊戲行程查詢改為快取後，若 PID 被重用且查詢持續成功，「遊戲結束」的判定最多可能延遲約 30 秒外加一次防抖間隔。
- 尚未驗證：1440p／超寬螢幕錄影的分析準確度、21:9／4:3 匯入影片的比例偵測、60 秒硬體錄影量測與遊戲 FPS 影響。
- Windows 執行檔未進行程式碼簽章。

### 更新方式

- **0.2.2 至 0.4.4 安裝版**可透過自動更新升級。
- **0.2.0／0.2.1 安裝版**請手動下載並執行 `Aditor-Setup-0.4.5.exe`。
- **免安裝版**請下載 `Aditor-0.4.5-Portable.exe` 手動更新。

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
