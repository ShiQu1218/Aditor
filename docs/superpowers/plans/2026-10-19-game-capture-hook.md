# 計畫：遊戲擷取（OBS graphics-hook）

## 背景與已驗證事項

- WGC 視窗擷取讓遊戲改由 DWM 合成，大廳滑鼠固定延遲；最小化 WGC 程式（不處理畫面）也延遲，無法從我們這端修正。
- DDA 沒有延遲，但只能抓螢幕：遊戲切到背景時只能送黑幀，看不到大廳／開局，兩局會合併（已用「連續全黑 60 秒結束對局」暫時處理）。
- `recorder/examples/hook_probe.rs` 實測（Apex DX12、RTX 5080、OBS 32.1.2 的 hook 1.8.7）：
  - 以 OBS 官方簽章的 `graphics-hook64.dll`、反作弊相容模式（`SetWindowsHookEx`）注入，EA Javelin Anticheat 沒有阻擋。
  - 大廳滑鼠**沒有延遲**。
  - 遊戲在背景（未最小化）時共享材質**持續更新**。
  - `OpenSharedResource` 可把 hook 的共享材質開進我們的 D3D11 裝置；格式為 `R8G8B8A8_UNORM`（28），3840×2160。

## 決策

1. **隨 Aditor 附帶 OBS 官方簽章的 hook 檔**（`graphics-hook64.dll`、`inject-helper64.exe`、`get-graphics-offsets64.exe`），不要求使用者安裝 OBS。授權：OBS 為 GPL-2.0-or-later，與本專案 GPL-3.0 相容；`THIRD_PARTY_NOTICES.md` 註明版本、授權與原始碼連結。只用官方建置，不自行編譯（自行簽章不會被反作弊放行）。
2. **預設擷取方式改為遊戲擷取**；hook 在時限內未就緒（被擋、載入失敗、非支援的 API）就**自動退回 DDA**，並通知使用者一次。
3. **OBS 優先**：
   - 遊戲裡已有其他程式在用 hook（`CaptureHook_KeepAlive{pid}` 已存在且不是我們建立的）→ 不碰，改用 DDA。
   - 錄影後端為 OBS 時，偵測用擷取一律使用 DDA，不注入，避免與 OBS 的遊戲擷取搶同一組具名物件。

## 協定摘要（對照 OBS 32.1.2 原始碼）

| 步驟 | 動作 |
|---|---|
| 偏移 | 執行 `get-graphics-offsets64.exe`，解析 ini 輸出（`[dxgi] present/present1/resize/release` 等） |
| keepalive | `CreateMutexW("CaptureHook_KeepAlive{pid}")`；hook 每 5 秒檢查，不存在即停止 |
| 既有 hook | `OpenEventW("CaptureHook_Restart{pid}")` 成功 → `SetEvent`，不重新注入 |
| 注入 | `inject-helper64.exe "<dll>" 1 <視窗執行緒 ID>`（反作弊相容），結束碼 0 為成功 |
| 載入確認 | 輪詢 `CaptureHook_TextureMutex1{pid}` 是否存在 |
| 初始化 | 映射 `CaptureHook_HookInfo{pid}`（648 bytes），填 `offsets`、`frame_interval`、`allow_srgb_alias=true`、`force_shmem=false`、`capture_overlay=false`；`SetEvent(CaptureHook_Initialize{pid})` |
| 就緒 | 等 `CaptureHook_HookReady{pid}`；讀 `hook_info` 的 `type/window/map_id/cx/cy/format` |
| 材質 | 映射 `CaptureHook_Texture_{window}_{map_id}`，取 `tex_handle`（舊式共享 handle），`OpenSharedResource` |
| 重新初始化 | 遊戲改解析度／重建 swapchain 時 hook 會再次觸發 HookReady → 重開材質 |
| 停止 | `SetEvent(CaptureHook_Stop{pid})`，關閉 keepalive；DLL 留在遊戲中，下次以 Restart 沿用 |
| log | 建立 `\\.\pipe\CaptureHook_Pipe{pid}` 接收 hook 的文字 log，寫入診斷紀錄 |

## 設計

### 錄影器（Rust）

- `types::CaptureMethod` 新增 `Hook`（protocol 字串 `"hook"`）。
- 新模組 `capture/hook/`：
  - `protocol.rs`：`HookInfo`（`repr(C)`，編譯期斷言 648 bytes）、具名物件名稱、偏移 ini 解析。純函式，可單元測試。
  - `inject.rs`：偏移取得、keepalive、注入、載入／就緒等待；全部有逾時。
  - `mod.rs`：`run(...)`，與 WGC／DDA 同介面，由 `Capture::start_with` 分派。
- **顯示卡**：舊式共享 handle 不能跨卡。依序在各轉接器上嘗試 `OpenSharedResource`，用第一個成功的建立 `Gpu`；`session.rs` 的 `Gpu` 改為由擷取方式決定（hook 需先拿到 handle 才能決定裝置，因此 hook 的初始化在建立 `Gpu` 之前完成）。
- **格式轉換**：編碼器與小圖只接受 `B8G8R8A8_UNORM`。
  - `B8G8R8A8_*`：`CopyResource` 到自有的 BGRA 材質（同家族格式）。
  - `R8G8B8A8_*`、`R10G10B10A2_*`：以 compute shader 讀 SRV（typeless 以對應 UNORM view）寫入 BGRA UAV。
  - 每格都先複製到自有材質再交給消費者，避免 hook 寫入時讀到撕裂畫面，也讓 `CapturedFrame.texture` 的生命週期由我們掌控。
- **取格節奏**：hook 沒有「新畫面」通知，按設定 fps 自行計時取格（pts 用 `clock::now_ticks`）；`hook_info.frame_interval` 設為 1/fps，讓遊戲端的複製不超過需要。
- **可見度**：遊戲最小化（`IsIconic`）時 Apex 停止 Present，材質停在最後一格；此時比照 DDA 送黑幀並發 `game_hidden`／`game_visible`，分局判斷沿用現有的全黑邏輯。未最小化的背景狀態照常送遊戲畫面。
- **失敗與退回**：hook 初始化（含注入、載入、就緒）超過 15 秒、注入結束碼非 0、`type` 不是共享材質、或 KeepAlive 已被他人持有 → 回傳 `hook_unavailable` 錯誤（附原因），由 App 端退回 DDA。
- **生命週期**：hook 送出 Stop、遊戲視窗消失、或材質重建時，重新等待 HookReady 並重開材質；遊戲重啟由 App 端既有的「PID 變更 → 重新開始錄影」處理。
- **hook 檔位置**：start 參數新增 `hook_dir`（App 傳入資源目錄）；缺檔或簽章無效時直接回 `hook_unavailable`。

### App（TypeScript）

- `RecordingCaptureMethod` 新增 `'hook'`，預設改為 `'hook'`；設定頁新增選項與說明（各語系 i18n）。
- `session.ts`：
  - 後端為 OBS 時，送給錄影器的擷取方式一律為 `'dda'`。
  - 錄影器回 `hook_unavailable` → 本次遊戲程序改用 DDA 重新開始（以 PID 記住，遊戲重啟後再試 hook），並通知使用者一次原因。
  - 傳入 `hook_dir`（打包後為 `resources/obs-hook`）。
- `electron-builder.yml`：`extraResources` 加入 `../build/obs-hook → obs-hook`。
- 建置腳本：從指定的 OBS 官方發行版取出三個檔案到 `build/obs-hook/`，並驗證 Authenticode 簽章（`CN="OBS Project, LLC"`）與 SHA-256。

### 文件

- `THIRD_PARTY_NOTICES.md`：OBS graphics-hook 的版本、授權、原始碼連結。
- 設計文件 `2026-10-18-live-recording-design.md` 的擷取方式段落更新。

## 測試

- 單元（Rust）：`HookInfo` 佈局與大小、偏移 ini 解析（含缺欄位、非十六進位）、具名物件名稱、格式→轉換方式對應、退回條件判斷。
- 單元（TS）：OBS 後端強制 DDA、`hook_unavailable` 退回與 PID 記憶、設定預設值與舊設定相容。
- 整合（Rust，`#[ignore]`，需 hook 檔）：啟動一個 D3D11 flip-model 測試視窗程序，注入 hook，驗證收到畫面、尺寸、改解析度後重開材質、keepalive 移除後 hook 停止。
- 實機（手動）：Apex 大廳延遲、背景畫面更新、最小化轉黑幀、切出去打下一局能分局、OBS 遊戲擷取開著時退回 DDA、遊戲重啟。

## 風險

- 反作弊：本次實測未被 EA Javelin Anticheat 阻擋，但無法保證長期；OBS 換簽章時（見 OBS「Capture Hook Certificate Update」，相容性表中 EA Anti-Cheat 的狀態僅供參考）反作弊／Javelin 可能需要隨遊戲或規則更新才會放行新憑證。附帶版本要跟隨 OBS 正式版定期更新，並保留 DDA 退回。
- 32 位元遊戲：本計畫只處理 64 位元（Apex 為 64 位元）；32 位元遊戲直接退回 DDA。
- Vulkan／OpenGL 遊戲：hook 本身支援，但格式／共享方式可能不同；超出本計畫範圍，未支援時退回 DDA。

## 步驟

1. Rust：`capture/hook/protocol.rs` 與單元測試。
2. Rust：注入、初始化、就緒等待與 log pipe（沿用 `hook_probe.rs` 驗證過的流程）。
3. Rust：多顯示卡選擇、格式轉換 shader、取格節奏、可見度處理，接上 `Capture::start_with`。
4. Rust：整合測試（D3D11 測試視窗）。
5. 建置：取得與驗證 OBS hook 檔，`electron-builder.yml`、`THIRD_PARTY_NOTICES.md`。
6. App：設定、i18n、`session.ts` 退回邏輯與測試。
7. 實機驗證清單；移除 `examples/hook_probe.rs`（或保留為診斷工具）。
