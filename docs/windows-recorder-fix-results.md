# Windows 錄影器 D1／D2／D3／D4／D6／D7 修補結果

> 協調者最終驗收：`cargo check --locked --bin aditorrec` 與 `cargo test --locked --bin aditorrec --no-run` 通過；相關 13 項單元測試通過。下文「未執行 cargo」記錄的是工作者交件當時的狀態。未執行音訊與 GPU 的實機整合測試。

- 日期：2026-10-22
- 任務：修補 Rust 錄影器的 Windows 相容性缺陷 D1、D2、D3、D4、D6、D7
- 分支：`ShiQu1218/chore-check-win10-win11`
- 基準 commit：`5ee7a1e`
- 執行者：OpenCode `opencode/deepseek-v4.1-flash-free#max`（受協調者監督）
- 實機測試：**未執行**。依任務限制，未啟動 Aditor、未錄影／收音、未啟動遊戲、未執行硬體測試；亦未執行 `cargo build`／`cargo test`／`cargo clippy`。依約由協調者統一準備相依套件與編譯驗收。
- 所有權：只修改 `recorder/src/` 下的六個檔案，並新增本報告；未修改 `app/`、相依鎖檔或其他文件。

## 1. 修補摘要

| 項目 | 修補結果 |
|---|---|
| D1 | 單一音訊來源失效不再設定全域停止旗標；混音器只丟棄失效來源，以剩餘來源或靜音繼續輸出，直到 session 停止。session 將音訊警告轉為可見事件，watchdog 改為一次性警告而非致命錯誤。 |
| D2 | 啟用中的 `default` 端點不存在時發出 `audio_device_missing` 警告並繼續；保留靜音 AAC 軌與 `audio=true`。明確指定但不存在的裝置仍維持啟動失敗。 |
| D3 | DDA 重新開啟失敗時，以同一份 DXGI adapter 快照及 LUID 正向確認 monitor 是否屬於另一個 adapter；只有確定跨卡才乾淨失敗。monitor 暫時不存在、鎖定、模式切換或同卡恢復仍持續重試，不重建完整 GPU 管線。 |
| D4 | 僅 DDA 在實際 adapter 不支援使用者指定的編碼器時，發出 `encoder_fallback` 警告並回退到**同 codec**且已通過試編碼的硬體編碼器。WGC 的明確指定語義不變。 |
| D6 | `SetIsCursorCaptureEnabled(false)` 改為 best effort，失敗只記錄訊息，不再使整段擷取初始化失敗。 |
| D7 | 保存 WGC monitor fallback 的實際 `HMONITOR`，每秒比對 `MonitorFromWindow`；變更時先丟棄舊 capture，再於新螢幕重建。重建失敗不會繼續錄舊桌面。檢查順序先處理 capture closed／`!window_matches`，再處理 monitor 搬移。 |

## 2. 各項修補設計

### 2.1 D1：執行中音訊失效只降級，不中止錄影

**原本問題**：任一端點執行緒發生錯誤時設定全域 `stop` 旗標；音訊執行緒全部結束後，`last_audio` 不再更新，session 在下一次 5 秒統計判定音訊停擺並回傳 `AudioFailed`，Electron 進入 `crashed()`，影片也一起停止。

**修改內容**：

- `recorder/src/audio/mod.rs`
  - `EndpointStream::run()` 失敗時不再 `stop.store(true)`，改為發出 `AudioWarning { code: "audio_source_lost" }`；其他來源與影片不受影響。
  - `mix_loop()` 分別 drain 系統音訊與麥克風；任一來源的轉換錯誤只將該來源設為 `None`，發出一次對應警告，另一來源繼續混音。
  - 所有來源都失效後仍持續產生靜音區塊，直到 session 設定停止旗標；不再因兩個來源的正常斷線而提前結束混音。
  - 新增 `AudioWarning`、`drain_warnings()` 與 `missing_endpoint_warning()`／`source_lost_warning()`，讓 session 能逐筆轉為可見事件。
- `recorder/src/session.rs`
  - 啟動時與每次 `drain()` 都將 `AudioWarning` 轉成 `Event::Warning`。
  - 5 秒 watchdog 改為只發出一次 `audio_capture_stalled` 警告，不再回傳 `AudioFailed`；影片與 writer 的致命錯誤處理維持不變。
  - `audio_stall_warned` 與一般來源警告分開，`game_audio_unavailable` 等訊息不會永久遮蔽真正的停擺警告。
- `game_audio_unavailable` 的既有回退警告仍保留；它與 D1 的來源中斷警告各自使用獨立代碼。

**新增／保留測試**（`recorder/src/audio/mod.rs`）：

| 測試 | 證明的行為 |
|---|---|
| `runtime_source_loss_warning_names_the_failed_source` | 來源中斷警告代碼與訊息會指出是系統音訊或麥克風。 |
| `source_loss_keeps_emitting_silence_until_the_session_stops` | 正常斷線不算失敗；失去來源後仍持續輸出靜音直到停止。 |
| `one_lost_source_keeps_the_other_source_audible` | 系統音訊轉換失敗後，麥克風仍有非零樣本送進混音；失去的來源最終補靜音。 |
| `both_lost_sources_keep_emitting_silence_until_stop` | 兩個來源都中斷後仍持續輸出全零區塊直到停止，且兩個來源各發一次警告。 |

### 2.2 D2：缺少預設端點要提示，但保留音軌語義

**修改內容**（`recorder/src/audio/mod.rs`）：

- `optional_endpoint()` 遇到 `audio_device_missing:` 時，發出 `audio_device_missing` 警告後回傳 `Ok(None)`；不再靜默吞掉。
- 保留原本的靜音 AAC 軌與 `audio=true` metadata；不為消除靜音而重構 mux。
- 只有 `default` 端點缺少會被視為可降級；明確指定但不存在的裝置仍回傳啟動錯誤（既有整合測試的要求）。

**測試**：`missing_default_endpoint_warns_but_explicit_missing_device_stays_fatal` 驗證 default 缺失可警告降級、明確裝置缺失仍致命。

### 2.3 D3：DDA 跨 adapter 只用 LUID 正向確認

**修改內容**（`recorder/src/capture/dda.rs`）：

- 新增 `luid_key()`、`monitor_on_other_adapter_snapshot()` 與 `monitor_on_other_adapter()`。
- `Duplication::open()` 失敗後，先取得目前 D3D11 device 所屬 adapter 的 LUID，再列舉一次所有 adapter 與其 output monitor；只有當目標 monitor 出現在**不同 LUID** 的 adapter 上，才判定跨卡並 `bail!` 走既有乾淨收尾。
- monitor 暫時不存在（顯示器休眠、鎖定、模式切換、拓撲暫時變動）或列舉失敗，都回傳 `None` 並維持重試；不重建完整 GPU 管線。
- 同一個 adapter 內搬移螢幕時，DDA 會在新 monitor 上重新建立 duplication，不會誤判跨卡。

**測試**：`cross_adapter_requires_a_positive_luid_match_on_another_adapter` 驗證同 LUID 不算跨卡、不同 LUID 才算、monitor 不在任何 adapter 時保持可重試。

### 2.4 D4：DDA 指定編碼器的同 codec 回退

**修改內容**（`recorder/src/session.rs`、`recorder/src/encode/mod.rs`、`recorder/src/gpu.rs`）：

- 新增 `Gpu::vendor()`，以實際 D3D11 device 所屬 adapter 的 `IDXGIAdapter::GetDesc()` 取得 vendor（不是 `IDXGIAdapter1::GetDesc1()`）。
- 新增 `same_codec_fallback()`：只從實際 adapter 上以試編碼確認可用的硬體編碼器中，挑選與 `cfg.codec` 相同且名稱不同者。
- 新增 `dda_encoder()`：僅在 `CaptureMethod::Dda` 且使用者明確指定編碼器時執行。指定編碼器不在該 adapter 的可用清單時，發出 `encoder_fallback` 警告並使用同 codec 的替代品；若沒有同 codec 替代品，保留原名稱，讓 `SegmentWriter::open()` 回報既有的 `no_hw_encoder` 詳細錯誤。
- 未使用 `candidate_names(HEVC, "auto")` 之類會附帶 H264 的清單，避免靜默變更 codec。
- WGC 路徑完全不呼叫 `dda_encoder()`，維持使用者手動指定編碼器的語義。

**測試**：`dda_encoder_fallback_never_crosses_the_requested_codec` 驗證同 codec 回退、不重選自身、沒有同 codec 時回傳 `None`。

### 2.5 D6：游標設定改為 best effort

**修改內容**（`recorder/src/capture/mod.rs`）：

- `session.SetIsCursorCaptureEnabled(false)` 的錯誤不再以 `?` 中斷 `ActiveCapture::new()`；改為記錄 warning，擷取繼續。
- `SetIsBorderRequired` 與 `SetMinUpdateInterval` 原本已是忽略錯誤的可選設定，維持不變。

**版本邊界（依協調者裁定更正）**：

- `CreateForWindow` 的官方最低版本是 Windows 10 1903（18362），不是 1809。
- `SetIsCursorCaptureEnabled` 本身需要 Windows 10 2004（19041）以上；本修補只移除「1903／1909 因游標設定而整段失敗」這一個阻擋。
- **不能**因此推論 Windows 10 1809（17763）可錄影；1809 仍不在本次支援範圍。其他 WGC API 也各自有最低版本，本輪未提高或降低整體最低需求，也未實機驗證任何版本。

### 2.6 D7：monitor fallback 要追蹤實際螢幕

**修改內容**（`recorder/src/capture/mod.rs`）：

- `ActiveCapture` 新增 `monitor_target: Option<HMONITOR>`，在建立 monitor fallback 時保存 `MonitorFromWindow()` 的實際結果，確保 item 與變更偵測使用同一個螢幕。
- 管理執行緒每秒比對目前 `MonitorFromWindow(capture.hwnd)`；只有 monitor fallback 需要重建，視窗擷取本身會跟著視窗。
- 檢查順序調整為：
  1. 先處理 `signals.closed` 或 `!window_matches(capture.hwnd, opts.pid)`，立即丟棄舊 capture 並發出 `WindowLost`。
  2. 再處理黑畫面 fallback 切換。
  3. 最後才比對 monitor 是否搬移。
- 檢查順序可避免對已關閉、或 HWND 已被其他 PID 重用的視窗建立 monitor capture。
- monitor 搬移時先 `drop(active.take())` 停止舊 capture，再建立新 item；重建失敗時 `active` 保持 `None`，不會繼續錄舊桌面，之後可回到視窗擷取或等待下一個視窗。
- 新增 `monitor_moved()` 的單元測試 `monitor_fallback_rebuilds_only_when_the_window_moves_to_another_display`。

## 3. 測試狀態

### 3.1 已做的靜態檢查

- 以 `rustfmt --edition 2021 --check` 解析六個修改檔，確認沒有語法錯誤。專案原本就不是全檔 rustfmt-clean，`--check` 會列出既有格式差異；本輪未對整檔重排，以免產生無關 diff。
- `git diff --check` 無空白錯誤。

### 3.2 未執行的驗證

- **未執行 `cargo build`／`cargo check`／`cargo test`／`cargo clippy`**：依任務分工由協調者統一準備 FFmpeg 開發檔與編譯，避免並行建置衝突。
- **未執行整合測試**：`recorder/tests/audio_capture.rs` 等需要實際 WASAPI 裝置或 GPU 的測試未執行。
- **未執行硬體測試**：未驗證拔除 USB／藍牙音訊、停用預設裝置、DDA 跨卡搬移、WGC fallback 搬移螢幕、HDR／旋轉螢幕、Windows 10 1903／1909 等實機情境。
- **未驗證 UI**：未啟動 Electron，因此 `Event::Warning` 是否正確顯示、警告文案與層級是否符合 App 期待，仍待整合驗證。

建議協調者依序執行：

```sh
cargo check --manifest-path recorder/Cargo.toml
cargo test --manifest-path recorder/Cargo.toml
cargo clippy --manifest-path recorder/Cargo.toml --all-targets -- -D warnings
```

（實際 FFmpeg 環境變數與 feature 設定依協調者既有流程。）

## 4. 驗收對照

| 裁定要求 | 實作狀態 |
|---|---|
| D1 單一來源失效保留另一來源與影片 | 已改為逐來源降級；混音持續輸出；session 不再因音訊停擺回傳 `AudioFailed` |
| D1 以靜音補缺並發出一次可見警告 | 每個失效來源發一次 `audio_source_lost`；watchdog 另發一次 `audio_capture_stalled` |
| D1 保留影片／writer 致命錯誤 | 未修改 writer 的 `check_error()` 與影片管線錯誤路徑 |
| D2 缺少 default 要提示 | 新增 `audio_device_missing` 警告 |
| D2 保留相容音軌與 metadata | 仍建立 `AudioCapture`、靜音 AAC 與 `audio=true` |
| D2 明確指定裝置缺失仍致命 | `optional_endpoint()` 只對 `audio_device_missing:` 降級 |
| D3 確定跨卡才失敗 | 以單一 adapter 快照與 LUID 正向比對 |
| D3 暫時失去顯示器仍可重試 | monitor 不在任何 adapter 或列舉失敗時回 `None`，維持 retry |
| D3 不重建完整 GPU 管線 | 只建立／重建 duplication，未更換 D3D11 device |
| D4 只在實際 adapter 判斷 | `probe_encoders_for_family()` 在 DDA 的 `gpu` 上執行 |
| D4 同 codec 硬體回退並警告 | `same_codec_fallback()` + `encoder_fallback` |
| D4 不靜默換 codec／不動 WGC | 以 `codec_of()` 過濾；WGC 不呼叫 `dda_encoder()` |
| D6 游標設定 best effort | 失敗只記錄，不中斷擷取 |
| D6 不宣稱 1809 可用 | 文件明確標示 `CreateForWindow` 最低 1903；1809 仍不支援 |
| D7 保存實際 monitor | `ActiveCapture.monitor_target` |
| D7 螢幕變更安全重建 | 先丟棄舊 capture，再建立新 item |
| D7 重建失敗不錄舊桌面 | 失敗後 `active` 為 `None`，不會保留舊 capture |
| D7 先處理 closed／PID 變更 | 檢查順序已移到 monitor 搬移之前 |

## 5. 剩餘風險

1. **尚未編譯與執行測試**：本輪只能做靜態閱讀與 rustfmt 解析。Rust 型別、`windows` crate 介面簽名、借用檢查與測試時序，都要等協調者建置才能確認。
2. **D1 不重新開啟失效端點**：來源中斷後只以降級方式繼續，不會自動重連裝置。若使用者重新插回耳機，該次錄影仍不會恢復該來源；需要重新開始錄影。這是本次最小修補的刻意範圍。
3. **D1 watchdog 只警告一次**：`audio_stall_warned` 在第一次停擺後永久為 true；若音訊之後恢復又再次停擺，不會再發第二次 `audio_capture_stalled`。裁定要求一次性警告，這裡沿用該語義。
4. **D1 測試依賴實際時間**：新增的混音測試以 250～300 ms 睡眠觀察輸出，雖已放寬門檻，但在極度繁忙的 CI 上仍可能出現時序波動；建議協調者建置時一併觀察是否需改為虛擬時鐘。
5. **D2 的錯誤碼判斷仍以字串標記為主**：`missing_endpoint()` 依賴 `audio_device_missing:` 前綴。若未來 WASAPI 回傳其他「沒有預設裝置」的 HRESULT 而沒有被 `EndpointStream::open()` 映射，仍會走致命路徑；需要更多實機錯誤碼樣本。
6. **D3 只處理「開啟失敗後確認跨卡」**：若 adapter 熱插拔、驅動重置或顯示拓撲在 duplication 仍有效時變更，DDA 可能先收到 `ACCESS_LOST` 並重試；本輪沒有重建 D3D11 device 或跨 adapter 續錄。跨卡仍要求使用者改用視窗擷取。
7. **D3 的 LUID 快照可能與失敗當下不完全一致**：程式在 `Duplication::open()` 失敗後才重新列舉；若顯示拓撲在同一瞬間再次變動，可能得到 `None` 並多重試一輪。這是保守選擇，避免誤判跨卡而過早中止。
8. **D4 回退探測增加啟動成本**：`probe_encoders_for_family()` 會逐一試編碼；DDA 明確指定編碼器且該 adapter 不支援時，啟動可能多花數百毫秒。若替代品也失敗，才會由 `SegmentWriter::open()` 回報既有錯誤。
9. **D4 依賴 vendor 對應**：`Gpu::vendor()` 只認 NVIDIA／AMD／Intel 的 PCI vendor ID；未知或虛擬 adapter 會得到 `Vendor::Other`，可用清單為空，因而保留原指定編碼器並讓既有錯誤路徑處理，不會亂猜。
10. **D6 未提高最低版本保證**：`CreateForWindow` 1903、`SetIsCursorCaptureEnabled` 2004、`SetIsBorderRequired` 與 `SetMinUpdateInterval` 也各有版本門檻。本輪只讓游標設定失敗不致命，沒有實機驗證 1903／1909 的其他 API 行為。
11. **D7 最多約一秒的舊螢幕畫面**：monitor 檢查每秒一次；視窗搬移後到下一個檢查點前，仍可能錄到舊螢幕最多約一秒。若要更即時，需提高檢查頻率或監聽顯示設定事件，本輪未擴大範圍。
12. **D7 重建失敗後的復原路徑**：monitor 重建失敗會嘗試回到視窗擷取（若同 PID 視窗仍存在），或發出 `WindowLost` 等待下一個視窗；若使用者在失敗後立刻把視窗搬回，仍要等下一次每秒檢查才會重建。
13. **未驗證 App 端警告處理**：App 端 `Event::Warning` 的顯示與否不在本次所有權內；本輪只確保錄影器會發出事件。
14. **未驗證實際錄影檔**：未執行錄影、ffprobe、AAC 靜音軌或分段 MP4 播放測試；D1／D2 的容器與播放器行為仍屬靜態推論。

## 6. 變更檔案

- `recorder/src/audio/mod.rs`：D1 逐來源降級與持續靜音、D2 default 缺失警告、`AudioWarning` 通道、相關單元測試。
- `recorder/src/session.rs`：音訊警告轉事件、watchdog 改為一次性警告、D4 `same_codec_fallback()`／`dda_encoder()` 與測試。
- `recorder/src/encode/mod.rs`：`codec_of()` 改為 `pub(crate)` 供 D4 使用。
- `recorder/src/gpu.rs`：新增 `Gpu::vendor()`，以 `IDXGIAdapter::GetDesc()` 取得實際 adapter vendor。
- `recorder/src/capture/dda.rs`：D3 LUID 快照判定、跨卡才失敗、對應單元測試。
- `recorder/src/capture/mod.rs`：D6 游標設定 best effort、D7 保存 monitor target／每秒比對／安全重建與檢查順序、`monitor_moved()` 測試。
- `docs/windows-recorder-fix-results.md`：本報告。
