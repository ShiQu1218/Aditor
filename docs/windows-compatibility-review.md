# Aditor Windows 10／11 相容性審查

- 審查日期：2026-10-22
- 專案版本：`0.3.0`，Git commit `5ee7a1e`
- 審查範圍：Electron 介面、Rust 錄影器、Python 引擎、安裝與更新流程
- 審查方式：靜態程式碼追蹤、官方文件核對、既有測試與設定檢視
- 實機測試：**未執行**。本次沒有啟動 Aditor、沒有錄製畫面或音訊、沒有啟動遊戲、沒有安裝或更新、沒有執行發布或遠端寫入。

> 本報告的「已確認」是指程式碼路徑與官方 API 條件已可確定，不代表已在 Windows 10／11 實機重現。所有需要硬體、驅動程式或實際遊戲才成立的項目，均另列「待實機驗證」。

---

## 1. 審查方法與限制

### 1.1 已閱讀的專案資訊

- 根目錄與子目錄沒有 `AGENTS.md`，因此沒有專案自訂的代理指示可套用。
- 主要追蹤路徑：
  - `app/src/main/index.ts`、`app/src/main/recording/session.ts`、`app/src/main/quit-guard.ts`
  - `app/src/main/recording/aditorrec-client.ts`、`app/src/main/engine.ts`
  - `app/src/renderer/settings/RecordingControl.tsx`
  - `recorder/src/capture/mod.rs`、`recorder/src/capture/dda.rs`
  - `recorder/src/audio/mod.rs`、`recorder/src/session.rs`、`recorder/src/encode/mod.rs`
  - `app/electron-builder.yml`、`README.md`、`README.zh-TW.md`
- 預設擷取方式為 WGC；預設系統音訊與麥克風皆開啟，裝置為 `default`。預設值見 `app/src/shared/recording.ts:106-118`。
- 打包目標為 Windows x64 的 NSIS 安裝版與 portable 免安裝版，見 `app/electron-builder.yml:27-45`。

### 1.2 證據等級

本報告把結論分成三類：

1. **已確認缺陷**：程式碼控制流、錯誤處理或官方 API 最低需求已足以確定行為。仍可能需要實機確認發生頻率或實際畫面。
2. **既有防護**：程式碼已處理，或已有回退、提示、測試涵蓋，不列為新缺陷。
3. **待實機驗證風險**：程式碼有可疑點，但缺少 Windows 10／11、驅動程式、硬體或實際遊戲證據，不能直接判定為缺陷。

### 1.3 主機與工具限制

- 本次執行環境為 Windows 11 26H2（build `26300`），但 **Aditor 未被啟動**，因此不能把主機版本當成 Windows 10 或 Windows 11 的執行證據。
- 需要的檔案讀取、官方文件查詢與模型查詢均正常；**沒有遭遇工具權限拒絕**。
- 未修改任何產品程式碼、設定或既有文件；唯一新增的檔案是本報告。

---

## 2. 模型與推理設定

- 實際模型：`opencode/deepseek-v4.1-flash-free`（DeepSeek V4.1 Flash Free）
- 模型狀態：`active`
- 可用變體：`low`、`high`、`max`
- 推理強度：本次任務要求 `max`；我只能確認模型支援 `max`，**無法從目前工作階段的可讀介面確認實際 variant／reasoning effort 就是 `max`**。模型查詢工具只回報可用變體，沒有回報本次執行中的 variant。
- 本次沒有默默切換模型；若任務要求強制 `max`，應在啟動工作階段時明確指定 variant。此限制不影響本報告的程式碼審查內容。

---

## 3. 結論摘要

在 **Windows 10 22H2（19045）** 與 **Windows 11** 的預設 WGC 路徑上，靜態審查看不到會讓應用程式完全無法啟動的阻斷點。主要風險集中在：

- 音訊裝置失效會中止整場錄影，而不是只失去音訊。
- 缺少預設音訊裝置時，仍會產生無聲 AAC 軌，且沒有使用者提示。
- DDA 在跨顯示卡搬移螢幕後不會恢復，且介面沒有提示。
- DDA 的編碼器清單是全域清單，可能選到目前顯示卡不支援的硬體編碼器。
- 離開程式只有 5 秒收尾上限，可能短於實際錄影收尾與 remux 時間。

| 編號 | 嚴重度 | 問題 | 主要影響版本／組態 |
|---|---|---|---|
| D1 | 高 | 執行中音訊失敗會停止整場錄影 | Windows 10 22H2、Windows 11；USB／藍牙裝置失效 |
| D2 | 中 | 缺少預設裝置仍建立無聲音軌且無提示 | 所有版本；停用或移除預設播放／錄音裝置 |
| D3 | 中 | DDA 跨顯示卡搬移螢幕後永不恢復 | 多螢幕、混合顯卡、DDA |
| D4 | 中 | DDA 可選到顯示卡不支援的編碼器 | 混合顯卡、DDA、手動指定編碼器 |
| D5 | 中 | 5 秒離開上限可能中斷錄影收尾 | 所有版本；錄影中或收尾中離開程式 |
| D6 | 低 | WGC 游標 API 把實際最低版本提高到 Windows 10 2004 | Windows 10 1809／1903；1803 更早失敗 |
| D7 | 低 | WGC 黑畫面回退後鎖定舊螢幕 | WGC 視窗擷取回退到螢幕擷取後搬移視窗 |
| D8 | 低 | 音訊啟動固定 5 秒逾時 | 藍牙／USB 音訊裝置冷啟動較慢時 |

合計：高 1 項、中 4 項、低 3 項。另有 9 項待實機驗證風險，列於第 6 節。

---

## 4. 已確認缺陷

### D1：執行中音訊失敗會停止整場錄影

- **嚴重度**：高
- **Windows 版本／組建條件**：Windows 10 22H2（19045）與所有 Windows 11 版本；使用系統音訊或麥克風時。與顯示卡無直接關係。
- **檔案與行號**：
  - `recorder/src/audio/mod.rs:167-170`：任一端點執行緒發生錯誤時，設定全域 `stop` 旗標。
  - `recorder/src/session.rs:46`、`601-607`：每 5 秒統計；音訊超過 5 秒沒有輸出時，回傳 `AudioFailed`。
  - `app/src/main/recording/session.ts:569-573`、`633-640`：收到 `error` 後進入 `crashed()`，停止並收尾目前錄影。
- **觸發步驟**：
  1. 以系統音訊（或麥克風）開始錄影。
  2. 在錄影中拔除 USB 耳機／麥克風、關閉藍牙裝置、停用音訊端點、切換預設裝置、重新啟動 Windows Audio 服務，或讓音訊驅動程式重設。
  3. `EndpointStream::run()` 的 `GetNextPacketSize()`、`GetBuffer()` 或等待事件失敗；程式設定全域停止旗標。
  4. 在下一次 5 秒統計週期時（最慢約 10 秒內），`session.rs` 判定音訊沒有輸出，回傳 `AudioFailed`。
- **實際行為**：音訊失敗被當成整個工作階段的致命錯誤，而不是單一來源失效。錄影器結束，Electron 進入 `crashed()` 並收尾已完成的段落。
- **影響**：使用者只失去音訊，卻連影片一併停止；比賽後半段完全沒有畫面。若發生在比賽中，使用者當下不一定會看到錯誤，直到錄影停止才發現。
- **最小修正建議**：
  - 將音訊錯誤改為「單一來源降級」：關閉失效端點、發出 `audio_lost` 警告，混音執行緒以剩餘來源或靜音繼續，不設定全域停止。
  - 移除或放寬 `session.rs` 的 5 秒全域中止；只有影片管線也失敗時才停止工作階段。
  - 若所有音訊來源都失效，仍保留影片，並在 UI 顯示「影片繼續錄製，音訊已中止」。
- **可行驗證方式**：
  - 實機：錄影中拔除 USB 耳機，確認影片繼續、UI 出現警告、`session.json` 與最終 MP4 仍可播放。
  - 自動化：在音訊測試中以可控的假端點模擬 `GetBuffer()` 失敗，斷言 session 不回傳 `AudioFailed`；或將 `last_audio` 設為超過 5 秒並確認不再觸發全域停止。
- **證據等級**：程式碼控制流已確認；實際裝置錯誤碼與發生頻率待實機驗證。

### D2：缺少預設音訊裝置仍建立無聲 AAC 軌且無提示

- **嚴重度**：中
- **Windows 版本／組建條件**：所有 Windows 10／11。使用 `renderDevice: 'default'` 或 `captureDevice: 'default'`，且對應裝置不存在、被停用或沒有預設裝置時。
- **檔案與行號**：
  - `recorder/src/audio/mod.rs:84-97`：系統音訊與麥克風分別呼叫 `optional_endpoint()`。
  - `recorder/src/audio/mod.rs:120-131`：`audio_device_missing:` 被視為「沒有這個來源」，直接回傳 `Ok(None)`，不區分「使用者關閉」與「裝置不存在」。
  - `recorder/src/audio/mod.rs:597-649`：即使兩個來源都是 `None`，混音執行緒仍會持續產生靜音區塊。
  - `recorder/src/session.rs:541-559`、`569-583`：`AudioCapture` 建立成功，`session.json` 的 `audio` 欄位設為 `true`。
- **觸發步驟**：
  1. 在 Windows 設定中停用所有播放裝置，或移除 USB／藍牙音訊裝置，使預設播放裝置不存在。
  2. 設定為系統音訊開啟、麥克風關閉（或兩者都開啟但都沒有可用端點）。
  3. 開始錄影。
- **實際行為**：缺少的端點被吞掉，沒有警告；錄影器仍建立 AAC 音軌，`session.json` 回報有音訊，但內容是靜音。若只有系統音訊缺少、麥克風正常，則會錄到麥克風，但仍不會提示系統音訊已缺失。
- **影響**：使用者以為整場有遊戲聲音，事後才發現影片沒有聲音；也可能誤判為剪輯或播放器問題。無聲軌道也會增加不必要的檔案大小與處理時間。
- **最小修正建議**：
  - `optional_endpoint()` 回傳「缺少的原因」，由 `AudioCapture` 區分「刻意關閉」與「啟用但找不到裝置」。
  - 啟動時若有啟用中的端點缺失，發出明確警告（例如「找不到預設播放裝置，系統音訊不會被錄製」）。
  - 若完全沒有可用來源，不要建立音軌，或至少把 `session.json` 的 `audio` 設為 `false`，並在 UI 標示無聲。
- **可行驗證方式**：
  - 實機：停用預設播放裝置、只開系統音訊，錄製 10 秒；檢查 UI 警告、`session.json` 的 `audio` 欄位，以及 `ffprobe` 是否仍有 AAC 串流。
  - 自動化：以不存在的裝置 ID 呼叫 `optional_endpoint()`，斷言回傳缺失資訊；再以兩個 `None` 來源啟動混音，確認不會誤報有音訊。
- **證據等級**：程式碼已確認；實際 Windows 音訊端點行為待實機驗證。

### D3：DDA 跨顯示卡搬移螢幕後永不恢復，且介面不提示

- **嚴重度**：中
- **Windows 版本／組建條件**：使用 DDA 擷取；多螢幕分別由不同顯示卡驅動（常見於混合顯卡筆電、內顯＋外接顯卡、桌機多卡）。Windows 10 22H2 與 Windows 11 均可能發生。
- **檔案與行號**：
  - `recorder/src/capture/dda.rs:63-88`：`gpu_for_pid()` 只在開始時依遊戲視窗所在螢幕選一次 `Gpu`。
  - `recorder/src/capture/dda.rs:507-529`：每秒偵測到視窗搬到另一個 `HMONITOR` 時，只更新 `self.monitor`、清空 `dup`。
  - `recorder/src/capture/dda.rs:532-560`：`reopen()` 仍使用同一個 `gpu`；`Duplication::open()` 找不到新螢幕的 output 時持續失敗，3 秒後只送出 `WindowLost`。
  - `app/src/main/recording/session.ts:565-568`：`window_lost` 只寫入事件記錄，沒有使用者提示。
- **觸發步驟**：
  1. 選擇 DDA，開始錄影；遊戲視窗位於顯示卡 A 驅動的螢幕。
  2. 將遊戲拖到顯示卡 B 驅動的另一個螢幕，或使用 `Win+Shift+左／右` 搬移。
  3. `Tracker::check_window()` 更新螢幕，`Tracker::reopen()` 以原本的 `gpu` 重開失敗。
- **實際行為**：DDA 持續重試但永遠不會成功；3 秒後送出一次 `window_lost`，之後輸出閒置。`output.idle()` 只在視窗不可見時送黑畫面，遊戲可見時不再產生新影格，因此影片會凍結或大量缺格；錄影工作階段仍在進行。Electron 只記錄事件，沒有顯示警告或停止。
- **影響**：使用者可能錄到整段凍結、黑畫面或錯誤內容，且不知道發生什麼事；直到手動停止才發現。
- **最小修正建議**：
  - 在 `Tracker` 保存目前螢幕所屬的 adapter／`Gpu`；螢幕變更時重新解析 `gpu_for_monitor()`，必要時重建 `SdrConverter`、`BlackFrame` 與編碼管線。
  - 若完整重建成本過高，至少在偵測到跨 adapter 時發出使用者可見的錯誤並乾淨停止，而不是無限重試。
  - 將 `window_lost` 在超過一定時間後映射為 UI 警告。
- **可行驗證方式**：
  - 實機：混合顯卡筆電，內顯接筆電螢幕、dGPU 接 HDMI／DP；以 DDA 錄影，將遊戲搬到另一螢幕，觀察影片內容、日誌與 UI。
  - 自動化：以兩個 adapter 的 monitor 清單模擬 `locate()` 與 `reopen()`，確認目前程式會固定使用第一個 adapter。
- **證據等級**：程式碼路徑已確認；實際多卡螢幕切換行為待實機驗證。

### D4：DDA 模式可選到顯示卡不支援的硬體編碼器

- **嚴重度**：中
- **Windows 版本／組建條件**：DDA＋混合顯卡；遊戲螢幕由內顯或另一張顯示卡驅動，使用者在設定中手動選擇另一張卡的編碼器（例如螢幕在 Intel 內顯，卻選 `h264_nvenc`／`hevc_nvenc`；或螢幕在 NVIDIA，卻選 `h264_amf`／`h264_qsv`）。
- **檔案與行號**：
  - `app/src/renderer/settings/RecordingControl.tsx:91-94`：DDA 時 `selectedGpu` 為 `undefined`，編碼器選單使用全域 `caps.value.encoders`。
  - `app/src/renderer/settings/RecordingControl.tsx:132-133`：DDA 時只停用 GPU 選單，沒有同步限制編碼器。
  - `recorder/src/session.rs:432-439`：DDA 直接使用 `dda::gpu_for_pid()` 的顯示適配器，忽略使用者的 GPU 偏好。
  - `recorder/src/capture/dda.rs:63-88`：`Gpu` 綁定遊戲螢幕所屬 adapter。
  - `recorder/src/encode/mod.rs:138-160`、`272-311`：指定編碼器時只嘗試該名稱；若該 adapter 不支援，最終回傳 `no_hw_encoder`。
- **觸發步驟**：
  1. 在混合顯卡筆電上選擇 DDA。
  2. 遊戲位於內顯驅動的螢幕。
  3. 在編碼器選單選擇 NVIDIA／AMD／Intel 中非目前螢幕 adapter 的硬體編碼器。
  4. 開始錄影。
- **實際行為**：錄影器在 `SegmentWriter::open()` 階段找不到可用編碼器，回傳 `no_hw_encoder`；錄影直接失敗。UI 的清單讓使用者以為該編碼器可用。
- **影響**：使用者選了介面提供的選項卻無法錄影；若錯誤訊息還帶有 NVIDIA 驅動提示，可能誤導使用者去更新不相關的驅動程式。
- **最小修正建議**：
  - DDA 時只列出「遊戲螢幕所屬 adapter」可用的編碼器；由 recorder 回報 DDA capture adapter 與其 encoders，供設定頁使用。
  - 或允許選擇，但啟動時自動回退到該 adapter 可用的編碼器，並顯示警告；不要直接失敗。
  - 若保留全域清單，至少要在 UI 標示「此編碼器可能不適用於 DDA 螢幕」。
- **可行驗證方式**：
  - 實機：混合顯卡、DDA、螢幕接內顯，手動選 NVENC；確認目前版本失敗，修正後自動回退或選單不再出現 NVENC。
  - 自動化：以兩個 `GpuInfo`（不同 encoders）測 `RecordingControl` 的選項生成，斷言 DDA 時只使用目前 capture adapter 的 encoders。
- **證據等級**：程式碼與 UI 資料流已確認；實際 FFmpeg 在跨 adapter 的失敗訊息待實機確認。

### D5：5 秒離開上限可能中斷錄影收尾

- **嚴重度**：中
- **Windows 版本／組建條件**：所有 Windows 10／11。錄影中離開程式，或收尾／remux 超過 5 秒時；大檔案、較慢的 HDD、OneDrive／網路磁碟、Defender 掃描時更容易發生。
- **檔案與行號**：
  - `app/src/main/index.ts:311-327`：`createQuitGuard()` 的 `timeoutMs` 固定為 `5000`。
  - `app/src/main/quit-guard.ts:29-37`：`Promise.race([all, timeout])`，時間到就呼叫 `quit()`，不等待未完成的收尾工作。
  - `app/src/main/recording/session.ts:684-748`：`finish()` 依序停止錄影器、等待即時快照、處理 OBS、執行 `finalizeSession()`；其中包含 FFmpeg remux。
  - `app/src/main/recording/finalize.ts:183-206`：以 FFmpeg remux 產生最終檔案，完成後才 rename。
  - `app/src/main/recording/aditorrec-client.ts:125-145`：錄影器 `stop` 指令本身允許 15 秒，超過才強制 `kill()`；這比外層 5 秒更長。
- **觸發步驟**：
  1. 錄製長場次或高碼率影片。
  2. 在錄影中按離開，或錄影收尾／remux 期間離開。
  3. 若 `recordingService.stop()` 或 `finalizeSession()` 超過 5 秒，`quit-guard` 直接放行 `app.quit()`。
- **實際行為**：Electron 在收尾 Promise 完成前退出；Windows 不會自動終止子程序，錄影器或 FFmpeg 可能短暫殘留，`index.jsonl`、`.part`、最終檔案的 rename／入庫可能未完成。
- **影響**：使用者以為已儲存，但圖書館沒有新影片，或留下 `.part`／待復原檔案；下次啟動可能重做收尾，甚至產生重複項目。這是資料完整性風險，不只是「比較慢」。
- **最小修正建議**：
  - 將離開等待時間提高到至少涵蓋 `stop` 的 15 秒加上 remux 時間，或改成「等待收尾完成，顯示進度，必要時提供第二次強制離開」。
  - 分離「停止錄影」與「匯入圖書館」：至少確保錄影器完成檔案關閉後才允許退出。
  - 若仍要保留 5 秒上限，應在 UI 明確警告「收尾未完成，將於下次啟動復原」，並確保復原流程可靠。
- **可行驗證方式**：
  - 實機：錄製 30 分鐘以上、多分段，按離開，測量從按鈕到程式結束的時間；檢查最終檔、`.part`、`index.jsonl` 與下次啟動的復原結果。
  - 自動化：以超過 5 秒的假 task 測試 `createQuitGuard()`，確認目前會在 task 完成前呼叫 `quit()`；修正後斷言會等待。
- **證據等級**：程式碼已確認 timeout 行為；實際收尾是否超過 5 秒需依硬體與檔案大小驗證。

### D6：WGC 游標設定把實際最低版本提高到 Windows 10 2004

- **嚴重度**：低（實務上受影響的 1809／1903 已停止支援，但與 README 的廣泛宣稱不一致）
- **Windows 版本／組建條件**：
  - Windows 10 1809（17763）／1903（18362）／1909（18363）：`CreateFreeThreaded()` 可用，但 `SetIsCursorCaptureEnabled()` 不存在，`?` 會讓擷取建立失敗。
  - Windows 10 1803（17134）：更早就在 `CreateFreeThreaded()` 失敗。
  - Windows 10 2004（19041）以上：可用。
- **檔案與行號**：
  - `recorder/src/capture/mod.rs:401-408`：`CreateFreeThreaded()` 後直接 `session.SetIsCursorCaptureEnabled(false)?`。
  - `README.md:16`、`README.zh-TW.md:16`：宣稱 Windows 10／11 64 位元，未標示最低組建。
  - `app/src/shared/recording.ts:118`：預設 `captureMethod: 'wgc'`。
- **官方最低需求**：`GraphicsCaptureSession` 為 Windows 10 1803（17134）；`CreateFreeThreaded` 為 1809（17763）；`IsCursorCaptureEnabled` 為 2004（19041）。完整來源見 7.1 與參考來源 3～5。
- **觸發步驟**：在 Windows 10 1809 或 1903 安裝並以預設 WGC 開始錄影。
- **實際行為**：游標屬性的 WinRT 介面在舊版不存在，呼叫失敗；因為使用 `?`，整個 `ActiveCapture::new()` 失敗，錄影無法開始。這不是「游標無法關閉」而已，而是整段擷取建立失敗。
- **影響**：README 的「Windows 10」宣稱過寬；1809／1903 使用者會遇到無法錄影。Windows 10 22H2 不受影響。
- **最小修正建議**：
  - 將游標設定改為可選：`let _ = session.SetIsCursorCaptureEnabled(false);`，與下方 border／interval 的處理一致；舊版仍可錄影，只是游標可能入鏡。
  - 或依 `IsWindows10OrGreater`／build number 判斷，僅在 2004 以上呼叫。
  - 同步把 README 的最低需求改為「Windows 10 22H2 或 Windows 11」。
- **可行驗證方式**：在 Windows 10 1809（17763）VM 以預設 WGC 開始錄影；修正前應失敗，修正後應成功且可接受游標顯示。1803 可作為更早版本的對照。
- **證據等級**：程式碼與官方 API 最低需求已確認；實際 VM 行為待實機驗證。

### D7：WGC 黑畫面回退後鎖定舊螢幕

- **嚴重度**：低
- **Windows 版本／組建條件**：WGC 視窗擷取因黑畫面偵測而回退到螢幕擷取；之後遊戲搬到另一個螢幕，或顯示器拓撲改變。Windows 10 2004 以上與 Windows 11 均可能發生。
- **檔案與行號**：
  - `recorder/src/capture/mod.rs:382-386`：`CreateForMonitor()` 只在建立 `ActiveCapture` 時決定一次螢幕。
  - `recorder/src/capture/mod.rs:603-615`：黑畫面偵測觸發後，以當下的 `hwnd` 建立 monitor 擷取。
  - `recorder/src/capture/mod.rs:618-628`：之後每秒只檢查 item 是否關閉、視窗是否仍屬於同一 PID；沒有檢查 `MonitorFromWindow()` 是否改變。
- **觸發步驟**：
  1. 以 WGC 視窗擷取開始錄影。
  2. 因獨佔全螢幕、受保護內容或黑畫面偵測，回退為 monitor 擷取。
  3. 將遊戲視窗搬到另一個螢幕。
- **實際行為**：monitor 擷取 item 仍指向舊螢幕；錄影繼續，但內容是舊螢幕（可能只剩桌面或其他視窗）。程式不會重建 item，也不會提示。
- **影響**：使用者看到「有在錄」，但影片內容錯誤；直到停止或重新開始才恢復。
- **最小修正建議**：
  - 在 `ActiveCapture` 保存 fallback 的 `HMONITOR`；monitor 模式下每秒比對 `MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)`，不同就重建 `GraphicsCaptureItem`。
  - 或在螢幕變更時回到視窗擷取，重新跑黑畫面偵測。
- **可行驗證方式**：實機讓 WGC 進入 monitor fallback（例如獨佔全螢幕或黑畫面內容），再搬移視窗；檢查錄影是否跟著新螢幕。也可用單元測試模擬 monitor 變更與 `ActiveCapture::new()` 呼叫。
- **證據等級**：程式碼已確認沒有監看 monitor 變更；實際觸發 fallback 的遊戲情境待實機驗證。

### D8：音訊啟動固定 5 秒逾時，慢速藍牙裝置會讓錄影開始失敗

- **嚴重度**：低
- **Windows 版本／組建條件**：所有 Windows 10／11。藍牙耳機／麥克風冷啟動、USB 音訊裝置初始化、音訊服務剛啟動或驅動程式忙碌時。
- **檔案與行號**：
  - `recorder/src/audio/mod.rs:178-180`：等待端點就緒固定 `Duration::from_secs(5)`。
  - `recorder/src/session.rs:541-552`：`AudioCapture::start_for_pid()` 失敗時回傳 `AudioFailed`。
  - `app/src/main/recording/session.ts:522-524`：開始失敗會顯示「無法開始錄影」。
- **觸發步驟**：
  1. 使用藍牙耳機／麥克風，且裝置處於休眠或剛連線。
  2. 立即開始錄影。
  3. 端點開啟與格式協商超過 5 秒。
- **實際行為**：等待執行緒回報逾時，`AudioFailed` 使整個錄影開始失敗；即使影片管路已可運作，也不會以無音訊方式啟動。
- **影響**：使用者需要重試或先連好裝置；對藍牙使用者是明顯的啟動挫折。
- **最小修正建議**：
  - 將啟動等待改為較長（例如 15～30 秒）或重試一次，特別是藍牙端點。
  - 更好的做法是先啟動影片，音訊在背景開啟；失敗時只顯示警告，不阻止錄影。
  - 將 timeout 與 runtime watchdog 分開，不要把啟動慢等同於裝置失效。
- **可行驗證方式**：實機以藍牙耳機冷啟動立即錄影，記錄端點就緒時間；或在測試中以延遲超過 5 秒的假 `ready` 訊號重現。
- **證據等級**：程式碼已確認固定逾時；實際藍牙初始化時間待實機驗證。

---

## 5. 既有防護

以下機制已存在，審查時不列為新缺陷；但仍需注意其界線。

### 5.1 WGC

- `SetIsBorderRequired()` 與 `SetMinUpdateInterval()` 使用 `let _ =`，舊版缺少介面時不會中斷擷取（`recorder/src/capture/mod.rs:409-413`）。
- 擷取 item 關閉或視窗消失時會重建（`recorder/src/capture/mod.rs:618-638`）。
- 視窗擷取偵測到持續黑畫面時，會回退到螢幕擷取（`recorder/src/capture/mod.rs:533-543`、`603-615`）；但回退後有 D7 的螢幕鎖定問題。
- `IsBorderRequired(false)` 在 Windows 10 2004～22H2 沒有對應 API；在較新的 Windows 11 也需要 `graphicsCaptureWithoutBorder` capability 與使用者同意。Aditor 是未封裝的 Electron 應用，沒有宣告此 capability，因此黃色擷取邊框可能仍會顯示。這是視覺限制，不是錄影失敗。

### 5.2 DDA

- 依遊戲視窗所在螢幕選擇顯示適配器，避免在雙顯卡筆電上直接建立錯誤 adapter 的 device（`recorder/src/capture/dda.rs:63-88`）。
- `DXGI_ERROR_ACCESS_LOST` 會清除 duplication 並重試；`DXGI_ERROR_DEVICE_REMOVED` 會回報明確的 `capture_failed`，不會無限重試（`recorder/src/capture/dda.rs:713-727`）。
- duplication 無效時以 250 ms 間隔重試，避免短暫全螢幕切換立刻失敗（`recorder/src/capture/dda.rs:52-55`、`532-560`）。
- 視窗不可見或最小化時有黑畫面／idle 輸出處理（`recorder/src/capture/dda.rs:600-611`）。
- DDA 對旋轉螢幕不會主動旋轉；程式註解已明示保留 panel native orientation（`recorder/src/capture/dda.rs:11`）。這是已知限制，列於第 6 節待驗證。

### 5.3 音訊

- 遊戲專屬音訊（process loopback）失敗時會回退到系統音訊，並保存警告訊息（`recorder/src/audio/mod.rs:148-152`）。
- 回退成功時，`session.rs` 會發出 `game_audio_unavailable` 警告（`recorder/src/session.rs:553-557`）。
- 音訊格式轉換、時間軸對齊、靜音填補與佇列丟棄計數已有實作（`recorder/src/audio/mod.rs:597-649`）。
- 但「缺少預設裝置」與「執行中失敗」的處理仍有 D1／D2；不要因為有回退邏輯就認為所有音訊失敗都已安全降級。

### 5.4 編碼與 GPU

- 自動編碼器選擇會依序探測候選者；HEVC 自動模式還會回退到 H.264（`recorder/src/encode/mod.rs:137-160`）。
- 探測包含實際送出一格畫面的 trial encode，不只查詢硬體能力（`recorder/src/encode/mod.rs:173-209`）。
- 無可用編碼器時回傳 `no_hw_encoder`；NVIDIA 驅動過舊時會附上更新提示（`recorder/src/encode/mod.rs:211-238`）。
- 指定編碼器時只嘗試該名稱，這是 D4 的前提；自動模式較安全。
- 程式邏輯允許 WGC 使用任意 adapter（`recorder/src/session.rs:433-437` 的註解與分支），DDA 則必須在輸出 adapter 上建立 device；兩者行為不同，不能把 WGC 的 GPU 選擇邏輯直接套用到 DDA。WGC 跨 adapter 的實際限制仍待實機確認。

### 5.5 儲存、路徑與復原

- 錄影前檢查磁碟，低於停止門檻會停止並收尾；接近門檻會警告（`recorder/src/session.rs:609-611`、`recorder/src/session.ts:670-680`）。
- 儲存位置若是 OneDrive 等雲端同步資料夾或網路磁碟，會顯示警告（`app/src/main/recording/session.ts:800-801`）。
- 寫入前有可寫性探測；輸出先寫 `.part` 再 rename，降低半成品被當成完整檔案的機率（`app/src/main/recording/finalize.ts:183-206`）。
- 專案來源路徑會檢查絕對路徑、UNC／device path、副檔名與長度（`app/src/main/safe-path.ts:12-18`、`36-43`）。
- 目錄驗證會拒絕 symbolic link／junction 類路徑（`app/src/main/recording/finalize.ts:47-52`）。
- 收尾失敗會保留段落供下次復原，而不是直接刪除（`app/src/main/recording/session.ts:740-747`）。

### 5.6 程序與更新

- 單一實例鎖存在（`app/src/main/index.ts:330-338`）。
- 離開前有 quit guard，會嘗試停止錄影、取消匯出／代理、停止引擎（`app/src/main/index.ts:311-327`）；但 5 秒上限是 D5。
- 錄影器 `stop` 有 15 秒等待，之後才 `kill()`（`app/src/main/recording/aditorrec-client.ts:125-145`）。
- Portable 版不啟用自動更新；只有安裝版會檢查 GitHub Releases（`app/src/main/updater.ts:131-133`）。
- OBS 連線失敗時可回退到內建錄影器（`app/src/main/recording/session.ts:472-489`）。
- 引擎的 `stop()` 只對 Python 父程序呼叫 `p.kill()`（`app/src/main/engine.ts:238-252`）；子程序樹是否完全結束列於第 6 節待驗證。

---

## 6. 待實機驗證風險

以下項目不是本次可確認的缺陷；有些是程式碼層的明確限制，有些需要 Windows 10／11 硬體才能判定。

| 編號 | 風險 | 程式碼觀察 | 為何尚未確認 | 建議驗證 |
|---|---|---|---|---|
| V1 | 安裝版／免安裝版的 Windows 通知 | `app/src/main/index.ts` 沒有 `app.setAppUserModelId()`；通知建立於 `app/src/main/notify.ts:19-35`。Electron 桌面 toast 通常需要含 AppUserModelID 的 Start Menu 捷徑。 | NSIS 安裝版可能由安裝程式建立捷徑與 AUMID；portable 版沒有 Start Menu 捷徑，可能完全無法顯示 toast。需要實機比對。 | 安裝版與 portable 各執行一次錄影開始／完成／更新通知；檢查通知中心與 Windows 設定中的應用程式名稱。 |
| V2 | PowerShell 5.1 CIM 輸出編碼 | `app/src/main/recording/storage-location.ts:46-58` 以 `powershell.exe` 執行 `Get-CimInstance`，Node 以 UTF-8 解讀 stdout。 | Windows PowerShell 5.1 在管線／重導向時的輸出編碼可能隨系統地區設定改變；ASCII 標籤（OneDrive、Google Drive）不受影響，但中文磁碟區名稱可能亂碼。 | 在 zh-TW 系統建立中文磁碟區名稱，設定儲存位置到該磁碟，檢查雲端／網路分類與日誌；比對 PowerShell 7 行為。 |
| V3 | 引擎子程序樹清除 | `app/src/main/engine.ts:238-252` 只 `p.kill()` Python 父程序，沒有 Windows Job Object 或 `taskkill /T`。 | Python 可能再啟動 FFmpeg；Windows 不會因父程序結束自動殺子程序。實際是否殘留取決於 PyInstaller 與子程序建立方式。 | 開始匯出／分析後立刻離開，使用 Task Manager 或 `Get-CimInstance Win32_Process` 檢查 `aditor.exe`、`ffmpeg.exe` 是否殘留超過數秒。 |
| V4 | DDA 旋轉螢幕 | `recorder/src/capture/dda.rs:11` 明確表示保留 panel native orientation；`deliver()` 直接使用 `desc.Width`／`desc.Height`（`recorder/src/capture/dda.rs:601-606`）。Microsoft 文件要求 DDA 用戶端自行旋轉。 | 程式碼沒有旋轉步驟，旋轉螢幕很可能錄成橫向或內容轉 90 度；實際輸出仍需在 90／270 度螢幕確認。 | 將螢幕設為直向 90／270 度，以 DDA 錄影，檢查預覽與最終 MP4 的方向、比例與黑邊。 |
| V5 | FAT32 的 4 GiB 單檔限制 | 磁碟檢查只看剩餘空間；沒有偵測檔案系統或單檔大小上限。 | 高碼率長時間錄影可能產生超過 4 GiB 的檔案；FAT32 外接碟會在中途失敗。實際錯誤處理與回復路徑需測試。 | 以 FAT32 USB 碟錄製高碼率長場次，觀察是否在 4 GiB 前後停止、是否留下可復原段落、UI 是否顯示可理解的錯誤。 |
| V6 | 長路徑（>260 字元） | `app/src/main/safe-path.ts:13`、`37` 允許到 4096 字元；但 Node、Rust、FFmpeg 與 Windows 的長路徑支援取決於 manifest、登錄與 API。 | 程式碼沒有明確的 `\\?\` 轉換或長路徑測試；不能只憑路徑驗證就保證可錄影。 | 在 Windows 10／11 開啟與關閉 `LongPathsEnabled` 兩種情況，使用超過 260 字元的中文／空白路徑，測試錄影、收尾、匯出與圖書館入庫。 |
| V7 | 混合 DPI 與 HDR 色彩 | WGC／DDA 有 HDR→SDR 色調映射與 monitor 變更偵測（`recorder/src/capture/color.rs:107-125`）；DDA 執行緒設定 per-monitor DPI awareness（`recorder/src/capture/dda.rs:622-625`）。 | 靜態程式碼不能證明縮放、HDR 亮度、SDR 白點與多螢幕不同 DPI 的實際畫面正確。 | 150%／200% 縮放、SDR／HDR 切換、不同螢幕 DPI，錄影後比對預覽與 MP4 的尺寸、顏色與黑邊。 |
| V8 | 一般使用者安裝、Program Files 與更新 | NSIS 預設為非 per-machine，`allowToChangeInstallationDirectory: true`（`app/electron-builder.yml:42-45`）；更新由 electron-updater 寫入安裝目錄。 | 一般使用者安裝到預設 per-user 位置通常可行；若自訂到 Program Files，寫入與更新可能需要提升權限。安裝檔也沒有在本次檢查中執行。 | 以標準使用者帳戶安裝到預設路徑與 Program Files，執行檢查更新、下載、重新啟動安裝；確認 UAC、權限與失敗訊息。 |
| V9 | 反作弊、管理員權限與受保護內容 | WGC／DDA 需要可存取遊戲視窗；程式沒有要求提升權限。 | Apex／VALORANT 的視窗保護、反作弊、全螢幕獨佔與管理員權限差異只能在實際遊戲環境確認；本次禁止啟動遊戲。 | 在測試機以一般權限與系統管理員權限分別啟動遊戲，測試 WGC／DDA、Alt-Tab、獨佔全螢幕與擷取恢復。 |

補充：`app/src/main/recording/storage-location.ts:28-33` 的雲端分類只比對英文磁碟區標籤（例如 `Google Drive`）；這不是 Windows 相容性問題，但中文標籤的雲端磁碟可能不會被辨識，應一併在 V2 測試。

---

## 7. Windows 版本與 API 最低需求

### 7.1 官方最低需求核對

| 功能／API | 官方最低需求 | 對 Aditor 的意義 | 來源 |
|---|---|---|---|
| `Windows.Graphics.Capture.GraphicsCaptureSession` | Windows 10 1803（10.0.17134.0） | WGC 基礎類別；低於此版本無法使用。 | Microsoft Learn：GraphicsCaptureSession class |
| `Direct3D11CaptureFramePool.CreateFreeThreaded` | Windows 10 1809（10.0.17763.0） | 程式使用 free-threaded pool；1803 會在此失敗。 | Microsoft Learn：CreateFreeThreaded |
| `GraphicsCaptureSession.IsCursorCaptureEnabled` | Windows 10 2004（10.0.19041.0） | 程式以 `?` 呼叫；1809／1903 會讓整個擷取建立失敗，實際最低版本被提高到 2004。 | Microsoft Learn：IsCursorCaptureEnabled |
| `GraphicsCaptureSession.IsBorderRequired` | Windows 10 2104（10.0.20348.0） | 程式以 `let _ =` 嘗試；舊版沒有此介面時忽略。關閉邊框另需 `graphicsCaptureWithoutBorder` capability 與使用者同意。 | Microsoft Learn：IsBorderRequired |
| `GraphicsCaptureSession.MinUpdateInterval` | Windows 11 24H2（10.0.26100.0） | 程式以 `let _ =` 嘗試；較舊版本忽略，仍由 FrameGate 控制 FPS。 | Microsoft Learn：MinUpdateInterval |
| `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` | Windows 10 build 20348 | 遊戲專屬音訊需要此功能；Windows 10 22H2（19045）低於 20348，因此只能用系統音訊回退。Windows 11 21H2（22000）以上可用。 | Microsoft Learn：AUDIOCLIENT_ACTIVATION_TYPE |
| Desktop Duplication API（DDA） | Windows 8 以上 | Aditor 只在 Windows 10／11 執行；DDA 本身不是版本瓶頸。 | Microsoft Learn：Desktop Duplication API |
| Electron 33 | Windows 10 以上，64 位元 | Electron 33 官方支援 Windows 10 以上；Windows 7／8／8.1 已在 Electron 23 移除。 | Electron v33.2.1 README |

### 7.2 Windows 10 更早版本的支援範圍

以下只根據 API 需求與專案政策推導，不是實機測試結果：

| 版本 | 預設 WGC | DDA | 遊戲專屬音訊 | 判定 |
|---|---|---|---|---|
| Windows 10 1803（17134） | 失敗：`CreateFreeThreaded` 不存在 | 可用（若驅動支援） | 不支援 | 不支援 |
| Windows 10 1809／1903（17763／18362） | 失敗：`IsCursorCaptureEnabled` 不存在，`?` 中止 | 可用 | 不支援 | 不支援 |
| Windows 10 1909（18363） | 同上 | 可用 | 不支援 | 不支援 |
| Windows 10 2004～21H2（19041～19044） | 可用 | 可用 | 不支援；回退系統音訊 | 可執行，但 OS 已停止支援 |
| Windows 10 22H2（19045） | 可用 | 可用 | 不支援；回退系統音訊 | 最後一個 Windows 10 版本；Home／Pro 已於 2025-10-14 結束支援 |
| Windows 11 21H2（22000）以上 | 可用 | 可用 | 可用（build ≥ 20348） | 可用；但 21H2／22H2 已停止更新 |

**專案政策判定**：

- README 目前只寫「Windows 10／11，64 位元」，沒有最低組建。這個宣稱比程式實際可保證的範圍寬。
- 以預設 WGC 路徑計算，Aditor 的實際最低版本是 **Windows 10 2004（19041）**，不是所有 Windows 10。
- 以目前仍可合理宣稱的支援範圍計算，建議改為 **Windows 10 22H2（19045）或 Windows 11**；Windows 10 22H2 已於 2025-10-14 結束一般支援，是否提供 ESU 取決於使用者授權。
- Windows 10 1809／1903 已停止支援，且會被 D6 擋下；不建議列入正式支援矩陣，只保留為回歸測試的歷史版本。
- Windows 10 2004～21H2 雖可執行，但已停止支援；若要宣稱支援，應明確標示「不建議」或「best effort」。

---

## 8. 測試矩陣

### 8.1 已完成項目

本次沒有執行任何實機錄影、安裝、更新、遊戲啟動或音訊播放。已完成的是靜態與文件核對：

| 項目 | 方法 | 結果 |
|---|---|---|
| 官方 API 最低版本核對 | 查閱 Microsoft Learn：WGC、DDA、process loopback | 完成；詳見 7.1 |
| 程式碼呼叫鏈審查 | 追蹤 Electron → IPC → Rust recorder → FFmpeg | 完成；確認 D1～D8 的靜態路徑 |
| 模型與變體查詢 | `tools.opencode.models` | 完成；模型 active，變體 low／high／max；實際執行 variant 無法讀取 |
| 主機環境確認 | 讀取 Windows 版本 | Windows 11 26H2 build 26300；Aditor 未啟動，不能作為 Windows 10 證據 |
| Node `spawn` 的 `Path`／`PATH` 重複鍵輔助測試 | Node 24.16 實際建立子程序 | 子程序收到前置的 PATH；可作為參考，但 **不能** 直接證明 Electron 33／Windows 10 行為 |
| 實機相容性測試 | 無 | **0 項完成** |

### 8.2 建議測試矩陣（尚未執行）

優先級：P0 為釋出前必須；P1 為主要風險回歸；P2 為邊界情境。

| ID | 優先 | 作業系統／組建 | 顯示卡／裝置 | 帳戶與封裝 | 測試重點 | 對應項目 | 狀態 |
|---|---|---|---|---|---|---|---|
| T01 | P0 | Windows 10 22H2（19045，最後一般更新或 ESU） | NVIDIA 獨顯 | 標準使用者、安裝版、SDR、1080p | WGC 錄影 10 分鐘、停止、收尾、圖書館播放、影音同步 | 基準 | 未執行 |
| T02 | P0 | Windows 10 22H2 | AMD 獨顯 | 標準使用者、免安裝版 | DDA 錄影；同卡雙螢幕搬移；確認恢復 | D3 | 未執行 |
| T03 | P0 | Windows 10 22H2 | Intel 內顯 | 標準使用者、安裝版 | WGC、4K、HDR 開／關、SDR 色調映射 | V7 | 未執行 |
| T04 | P0 | Windows 10 22H2 | Intel 內顯＋NVIDIA dGPU（混合） | 標準使用者、免安裝版 | DDA；螢幕接內顯；手動選 NVENC；確認 D4 | D4 | 未執行 |
| T05 | P0 | Windows 10 22H2 | 任一 | 標準使用者、安裝版 | 停用預設播放裝置，只開系統音訊；確認 D2 | D2 | 未執行 |
| T06 | P0 | Windows 10 22H2 | 任一 | 標準使用者、安裝版 | 錄影中拔 USB／藍牙耳機；確認影片續錄 | D1 | 未執行 |
| T07 | P1 | Windows 10 22H2 | 藍牙耳機／麥克風 | 標準使用者、免安裝版 | 冷啟動立即錄影；量測端點就緒時間 | D8 | 未執行 |
| T08 | P0 | Windows 10 22H2 | 任一 | 標準使用者、安裝版 | 錄影中離開；長場次收尾中離開；檢查殘留與復原 | D5、V3 | 未執行 |
| T09 | P1 | Windows 10 22H2 | 任一 | 安裝版 vs 免安裝版 | 錄影開始／完成／更新通知；AUMID 與通知中心 | V1 | 未執行 |
| T10 | P1 | Windows 10 1809（17763）VM | 任一虛擬 GPU | 標準使用者、免安裝版 | 預設 WGC；確認 D6 修正前失敗、修正後成功 | D6 | 未執行 |
| T11 | P0 | Windows 11 24H2（26100.9711） | NVIDIA | 標準使用者、安裝版 | WGC／DDA、無邊框／獨佔全螢幕、Alt-Tab、HDR、VRR | 基準、D7 | 未執行 |
| T12 | P0 | Windows 11 25H2（26200.9711） | AMD | 標準使用者、免安裝版 | HDR、混合 DPI、1440p／4K、多螢幕 | V7 | 未執行 |
| T13 | P1 | Windows 11 26H2（26300.9711） | Intel Arc／Iris Xe | 標準使用者、安裝版 | WGC、4K、中文使用者名稱、長路徑、匯出 | V6 | 未執行 |
| T14 | P1 | Windows 11 26H1（28000.3231，若可取得） | 混合顯卡新裝置 | 標準使用者、免安裝版 | DDA／GPU 切換、睡眠／喚醒、顯示器拓撲變更 | D3、V9 | 未執行 |
| T15 | P1 | Windows 11 任一 | 內顯＋dGPU | 標準使用者、安裝版 | DDA 跨卡搬移螢幕；WGC fallback 後搬移螢幕 | D3、D7 | 未執行 |
| T16 | P1 | Windows 11 任一 | 任一 | 標準使用者、安裝版 | 自訂安裝到 Program Files；檢查更新、下載、重新啟動安裝 | V8 | 未執行 |
| T17 | P1 | Windows 11 任一 | 任一 | 標準使用者、免安裝版 | 中文／空白／>260 字元路徑、OneDrive、FAT32 USB | V2、V5、V6 | 未執行 |
| T18 | P2 | Windows 11 任一 | 任一 | 標準使用者、安裝版 | 鎖定／解鎖、RDP、睡眠／喚醒、顯示驅動重設 | DDA／WGC 恢復 | 未執行 |
| T19 | P2 | Windows 11 任一 | 任一 | 標準使用者、安裝版 | 直向 90／270 度旋轉螢幕，DDA 輸出方向 | V4 | 未執行 |
| T20 | P2 | Windows 11 任一 | 任一 | 標準使用者、免安裝版 | Windows on ARM 的 x64 模擬、Surface 類裝置 | 未涵蓋範圍 | 未執行 |

補充：

- Windows 11 23H2 已接近企業版更新終點（2026-11-10）；除非仍有企業客戶，否則不列為 P0。
- Windows 11 24H2 的 Home／Pro 已停止更新，Enterprise 仍可更新；測試時應記錄實際 edition 與 LCU。
- Windows 10 22H2 若沒有 ESU，最後安全性更新停留在 2025-10；這不影響程式執行，但應在支援聲明中揭露。

---

## 9. 未涵蓋範圍

- 未在 Windows 10 或 Windows 11 實機啟動 Aditor。
- 未錄製畫面、音訊或遊戲內容；未啟動 Apex Legends／VALORANT。
- 未測試反作弊、管理員權限、受保護內容或全螢幕獨佔的實際行為。
- 未安裝 NSIS、未執行 portable、未執行更新或重新啟動安裝。
- 未測試 Windows on ARM 原生執行；目前打包僅 x64。
- 未測試 Windows Server、Windows 10 LTSC／IoT Enterprise、Windows 10 ESU 的特定行為。
- 未進行長時間 soak test、記憶體／GPU 使用率、發熱、影格掉落或百場錄影的效能測試。
- 未測試所有 NVIDIA／AMD／Intel 驅動版本；只在必要時引用官方 API 需求。
- 未修改任何產品程式碼；本報告是最終審查輸出。

---

## 10. 參考來源

1. Microsoft Lifecycle：Windows 10 Home and Pro  
   https://learn.microsoft.com/en-us/lifecycle/products/windows-10-home-and-pro
2. Microsoft Learn：Windows 11 release information  
   https://learn.microsoft.com/en-us/windows/release-health/windows11-release-information
3. Microsoft Learn：`Windows.Graphics.Capture.GraphicsCaptureSession` class  
   https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession
4. Microsoft Learn：`Direct3D11CaptureFramePool.CreateFreeThreaded`  
   https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.direct3d11captureframepool.createfreethreaded
5. Microsoft Learn：`GraphicsCaptureSession.IsCursorCaptureEnabled`  
   https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession.iscursorcaptureenabled
6. Microsoft Learn：`GraphicsCaptureSession.IsBorderRequired`  
   https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession.isborderrequired
7. Microsoft Learn：`GraphicsCaptureSession.MinUpdateInterval`  
   https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession.minupdateinterval
8. Microsoft Learn：`AUDIOCLIENT_ACTIVATION_TYPE`  
   https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ne-audioclientactivationparams-audioclient_activation_type
9. Microsoft Learn：Desktop Duplication API  
   https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api
10. Electron v33.2.1 README：Platform support  
    https://raw.githubusercontent.com/electron/electron/v33.2.1/README.md
11. Microsoft Learn：How to enable desktop toast notifications through an AppUserModelID  
    https://learn.microsoft.com/en-us/windows/win32/shell/enable-desktop-toast-with-appusermodelid
12. Microsoft Learn：Quickstart: Sending a toast notification from the desktop  
    https://learn.microsoft.com/en-us/previous-versions/windows/desktop/legacy/hh802768(v=vs.85)

---

## 附錄：本次審查的檔案／行號索引

| 主題 | 檔案與行號 |
|---|---|
| WGC 建立、游標、border、interval | `recorder/src/capture/mod.rs:401-413` |
| WGC monitor fallback | `recorder/src/capture/mod.rs:603-615` |
| WGC 視窗重建與檢查 | `recorder/src/capture/mod.rs:618-638` |
| DDA adapter 選擇 | `recorder/src/capture/dda.rs:63-88` |
| DDA 螢幕變更與重開 | `recorder/src/capture/dda.rs:507-560` |
| DDA 主迴圈與錯誤處理 | `recorder/src/capture/dda.rs:666-727` |
| DDA 旋轉限制 | `recorder/src/capture/dda.rs:11` |
| 音訊端點與缺失處理 | `recorder/src/audio/mod.rs:84-131` |
| 音訊啟動逾時 | `recorder/src/audio/mod.rs:178-180` |
| 音訊執行失敗與停止旗標 | `recorder/src/audio/mod.rs:167-170` |
| 音訊混音與靜音輸出 | `recorder/src/audio/mod.rs:597-649` |
| 音訊 watchdog | `recorder/src/session.rs:601-607` |
| session.json 的 audio 欄位 | `recorder/src/session.rs:569-583` |
| GPU 選擇與 DDA 固定 adapter | `recorder/src/session.rs:432-439` |
| 編碼器候選與錯誤 | `recorder/src/encode/mod.rs:138-160`、`272-311` |
| DDA 編碼器 UI 清單 | `app/src/renderer/settings/RecordingControl.tsx:91-94`、`132-133` |
| 錄影錯誤與收尾 | `app/src/main/recording/session.ts:565-580`、`633-640`、`684-748` |
| 離開逾時 | `app/src/main/index.ts:311-327`、`app/src/main/quit-guard.ts:29-37` |
| 錄影器停止 | `app/src/main/recording/aditorrec-client.ts:125-145` |
| 引擎停止 | `app/src/main/engine.ts:238-252` |
| 儲存位置 CIM 查詢 | `app/src/main/recording/storage-location.ts:46-58` |
| 預設錄影設定 | `app/src/shared/recording.ts:106-118` |
| 打包目標與 NSIS | `app/electron-builder.yml:27-45` |
| 支援宣稱 | `README.md:16`、`README.zh-TW.md:16` |
