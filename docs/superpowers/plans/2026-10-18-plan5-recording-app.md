# Aditor — 計畫 5：錄影接進 App（第 2 期）

> **For agentic workers:** 你負責的任務只有一個（A1／A2／A3 之一）。先讀規格，再讀本檔「全域限制」與你的任務段落。

**Goal:** 開著 App（或常駐系統匣）時偵測到 Apex 就自動以 `aditorrec` 錄影；Apex 關閉後把段落串成一個 mp4（從頭錄到尾模式）加入媒體庫，並依設定排完整分析。含設定頁、系統匣、開機啟動、崩潰後補收尾。

**Spec:** `docs/superpowers/specs/2026-10-18-live-recording-design.md`（§2、§3.1–§3.2、§4.1–§4.5）
**aditorrec 協定：** 規格 §4.4；實作在 `recorder/src/protocol.rs`（以它為準）。手動測試工具 `recorder/tools/rec-cli.ps1` 示範了完整的 hello → start → stop 流程。

**骨架（已提交）：**
- `app/src/shared/recording.ts`：設定型別與預設、狀態、`RecordingService` 介面、IPC 頻道名。
- `app/src/main/recording/index.ts`：`RecordingDeps` 與 `createRecordingService` 簽章（A1 實作）。
- `app/src/main/recording-ipc.ts`：`registerRecordingIpc` 簽章（A2 實作）。

## 全域限制

- 只改你的任務擁有的檔案（下表）。**不得改動骨架既有的匯出簽章與 `shared/recording.ts` 既有欄位**；需要新增共用欄位時只能附加，並在報告列出。
- 沿用既有寫法：註解與使用者字串用繁體中文；設定驗證集中在 main；renderer 只透過 preload API；IPC 輸入要經過 guard（參考 `main/ipc-guards.ts`）。
- 不要新增 npm 依賴（Electron 內建的 `Tray`、`Notification`、`app.setLoginItemSettings` 已足夠）。
- 完成條件：在 `app/` 內 `npm run typecheck` 與 `npm test` 全過；你新增的邏輯要有 vitest 測試（假 aditorrec／假程序列表／暫存資料夾，不碰使用者資料）。
- 在自己的分支 commit（conventional commits，英文），不要 merge、不要 push、不要動其他 worktree 或主工作目錄。
- 最後的回覆是報告（繁體中文）：做了什麼、測試結果、已知限制、偏離計畫之處。
- worktree 沒有 `node_modules`：開始前在 `app/` 執行 `npm ci`（或 `npm install --prefer-offline`）。**不要建立指向主工作目錄 node_modules 的 junction。**

## 檔案擁有權

| 任務 | 擁有的檔案 |
|---|---|
| A1 錄影服務 | `app/src/main/recording/**`、`app/src/main/watch.ts`（只加「忽略 `.sessions`」） |
| A2 設定＋IPC＋介面 | `app/src/shared/settings.ts`、`app/src/main/settings.ts`、`app/src/main/recording-ipc.ts`、`app/src/preload/index.ts`、`app/src/renderer/global.d.ts`、`app/src/renderer/settings/**`、`app/src/renderer/shell/**`、`app/src/renderer/i18n/**`、新增的 renderer 錄影元件 |
| A3 整合（A1、A2 合併後） | `app/src/main/index.ts`、`app/src/main/tray.ts`（新）、`app/src/main/notify.ts`（新）、`app/src/shared/paths.ts`、`app/electron-builder.yml`、`scripts/build.ps1`、`app/resources/` 下新增的圖示 |

---

## A1 — 錄影服務（`app/src/main/recording/`）

建議拆檔：`apex-watcher.ts`（程序偵測）、`aditorrec-client.ts`（子程序＋JSON-lines）、`session.ts`（狀態機）、`finalize.ts`（串接）、`recovery.ts`（補收尾）、`disk.ts`。

1. **Apex 偵測**：預設 `findApexPid` 每 3 秒執行 `tasklist /FI "IMAGENAME eq r5apex*" /FO CSV /NH`（`windowsHide`），解析出第一個 `r5apex.exe` 或 `r5apex_dx12.exe` 的 PID。每次啟動偵測後首次成功輪詢立即回報；後續 PID 變更（含啟動、關閉及 PID 替換）需連續 2 次成功輪詢得到相同新值才確認（防抖）。查詢失敗不計次，也不清除待確認值。
2. **aditorrec client**：spawn `recorderCommand`（stdio pipe、`windowsHide`），逐行解析 stdout；`hello` 握手（逾時 10 秒）；請求以遞增 `id` 對應回覆；事件（無 `id`）轉給狀態機；stderr 保留最後 64 KB 供錯誤訊息。程序異常結束 → 狀態機處理。
3. **開始**：Apex 確認啟動、`autoRecord` 為真、未暫停 → `phase: starting`。錄影資料夾 = `outputDir` ?? 第一個監看資料夾 ?? `deps.defaultOutputDir`（不存在就建立）。`recording/` 內不要 import electron。建立 `<錄影資料夾>/.sessions/<sessionId>`（`YYYYMMDD-HHMMSS-xxxx`），讀 profile 的 `banner_roi`／`spec_roi`，送 `start`（`encode` 依設定；`height: 0` 表原生；`audio` 依 `micEnabled`／`micGain`／裝置）。收到 `started` → `phase: recording`。
4. **錄影中**：`segment` 事件更新 `segments`／`durationSec`；`stats` 更新 `droppedFrames`；`window_lost`／`window_found` 只記錄。每 30 秒用 `fs.promises.statfs` 查錄影資料夾所在磁碟：< `diskWarnGb` 通知一次（`diskWarn`）；< `diskStopGb` 主動 stop 並收尾，通知 `error`。
5. **結束**：Apex 確認關閉或 `stopManual` → 送 `stop`（逾時 15 秒則 kill）→ `phase: finalizing` → 收尾 → `idle`。
6. **aditorrec 當掉**：視為這段錄影結束，先收尾已有段落；若 Apex 仍在執行，以新的 sessionId 重新開始（指數退避 1/2/4/8/16 秒，10 分鐘內最多 5 次，超過 → `phase: error` 並通知）。v1 每次 aditorrec 執行各自輸出一個檔（規格說的「同一檔內標出中斷」留到之後）。`no_hw_encoder` 錯誤不重試，直接 `error`。
7. **收尾（`finalize.ts`）**：讀 `index.jsonl`（容忍最後一行不完整），段落 0 個 → 刪資料夾結束。否則把 `init.mp4` 與各 `seg_*.m4s` 依序以串流方式餵給 `ffmpeg -f mp4 -i pipe:0 -c copy -movflags +faststart <out>.part.mp4`（不在磁碟產生完整中間檔、不受命令列長度限制；若驗證 pipe 不可行，改成先串成暫存檔，並在報告說明），成功後 rename 成 `Apex_<YYYY-MM-DD_HH-mm>.mp4`（撞名加 `_2`、`_3`…）。輸出放錄影資料夾。成功 → 寫 `finalized.json`（輸出路徑）→ `addToLibrary` → 依 `postAnalysis`：`none` 不排；`afterExit` 與 `perMatch` 都在收尾後立即 `enqueueAnalysis`（session 模式下收尾時 Apex 已關閉；`perMatch` 的差別在第 4 期）→ 刪除 session 資料夾。失敗 → 保留資料夾、`error` 通知，下次啟動再試。
8. **補收尾（`recovery.ts`）**：服務 `start()` 時掃描所有可能的錄影資料夾（`outputDir`、各監看資料夾、預設資料夾）下的 `.sessions/*`：有 `finalized.json` 但資料夾還在 → 只刪資料夾（輸出若不在媒體庫就補加）；有段落但沒有 `finalized.json` 且不是目前錄影中 → 收尾。
9. **`watch.ts`**：監看忽略任何路徑含 `\.sessions\` 的檔案，以及 `*.part.mp4`。
10. **狀態推播**：所有變化經 `onStatus` 送出（去抖 250 ms，`segment` 事件不要每次都推）；`status()` 回傳目前快照（不可變物件）。
11. **測試**：假 aditorrec（node 腳本，依 stdin 指令回覆、可模擬 segment／stats／當掉／no_hw_encoder），假 `findApexPid`，暫存資料夾。覆蓋：自動開始／結束、暫停、手動開始停止、退避上限、磁碟兩段門檻、收尾成功（用真的 ffmpeg：`build/ffmpeg/bin/ffmpeg.exe`，以 `recorder` e2e 產生的或測試中用 ffmpeg 產生的小 fMP4 段落）、收尾失敗保留、補收尾、`.sessions` 被監看忽略。

## A2 — 設定＋IPC＋介面

1. **設定**：`Settings` 加 `recording: RecordingSettings`（預設 `DEFAULT_RECORDING_SETTINGS`）。`main/settings.ts` 的套用／驗證：列舉值必須在允許集合、數值夾在 `RECORDING_RANGES`、`diskStopGb` 不可大於 `diskWarnGb`（違反時把 stop 夾到 warn）、`outputDir` 必須是存在的絕對路徑資料夾（否則回 `errors.recordingOutputDir` 並不套用，比照 `defaultOutDir`）、`mode: 'match'` 在第 4 期前一律存成 `'session'`、`backend: 'obs'` 在第 5 期前一律存成 `'builtin'`。舊設定檔沒有 `recording` → 預設值（`migrateSettings` 已有的流程）。
2. **`recording-ipc.ts`**：`getStatus`、`getCapabilities`、`startManual`、`stopManual`、`setPaused`（布林 guard）；`service.onStatus` → 對每個未銷毀視窗 `send(RECORDING_CHANNELS.status, s)`。回傳的解除函式要移除 handler 與 listener。
3. **preload／global.d.ts**：`window.api.recording`：上述 invoke 包裝＋`onStatus(cb) => unsubscribe`。
4. **設定頁**：新分類「錄影」，列（依序）：自動錄影、開機啟動並常駐系統匣、關閉視窗時縮到系統匣、錄影模式（「從頭錄到尾」可選；「一局一個檔」顯示但停用並註明「對局偵測完成後開放」）、錄影資料夾（選擇／清除＝預設）、編碼格式（HEVC／H.264／AV1）、編碼器（自動＋`getCapabilities().encoders` 中符合格式者）、解析度（原生／1440p／1080p／720p）、FPS（30／60／120／144）、位元率（Mbps 顯示，存 kbps）、系統聲音裝置、麥克風（開關＋裝置＋音量）、錄後分析（不分析／關閉 Apex 後／每局結束後）、磁碟提醒門檻、磁碟停止門檻、對局通知。沿用既有 `rows.ts`／`SettingControls` 的寫法與搜尋。`getCapabilities` 回 null（aditorrec 不在）時編碼器與裝置只有「自動／預設」並顯示提示。
5. **側欄與狀態**：`Rail` 加「錄影」項目：`phase === 'recording'` 時紅點（`aria-label` 含「錄影中」）、`error` 時警示點；點擊開啟一個錄影狀態面板（浮層或小頁）：狀態、錄影時間（由 `startedAt` 即時計算）、段落數、編碼器與解析度、丟格數、磁碟剩餘、手動開始／停止、暫停自動錄影、錯誤訊息。第 3 期會把「觀看當局」接到這裡，先留一個停用的按鈕位置不需要。
6. **i18n**：新字串全部加到 `i18n/zh-TW.ts`。
7. **測試**：設定驗證與遷移（每個欄位的邊界與非法值）、IPC guard、preload 合約、設定頁列渲染與互動、Rail 狀態點與 a11y（沿用既有 a11y 測試寫法）。

## A3 — 整合、系統匣、開機啟動、打包（A1、A2 合併後）

1. **paths.ts**：`aditorrecCommand(isPackaged)`：開發＝`<repo>/recorder/target/release/aditorrec.exe`（不存在時退 `debug`），打包＝`<resources>/ffmpeg/bin/aditorrec.exe`（與 ffmpeg DLL 同層，DLL 自然找得到）；開發時 `env.PATH` 前置 `<repo>/build/ffmpeg/bin`。
2. **index.ts**：建立 `createRecordingService`（deps 由 settingsStore／library／queue／paths 組成，`addToLibrary` 後要讓 renderer 收到 `library:updated`，比照 watch 匯入的推播方式）→ `registerRecordingIpc` → `service.start()`；`before-quit` 的 quitGuard 加 `service.stop()`（會收尾，逾時沿用 5 秒上限；收尾未完成的留給下次補收尾）。
3. **單一執行個體**：`app.requestSingleInstanceLock()`；第二個執行個體 → 顯示並聚焦既有視窗。
4. **開機啟動**：`launchAtLogin` 變更時 `app.setLoginItemSettings({ openAtLogin, args: ['--hidden'] })`（僅打包版；開發版不註冊）。以 `--hidden` 啟動時不顯示主視窗，只建系統匣。
5. **系統匣（`tray.ts`）**：圖示三態（待命／錄影中紅點／錯誤），tooltip 顯示狀態；選單：打開 Aditor、開始錄影／停止錄影（依狀態）、暫停自動錄影（勾選）、結束。雙擊開啟視窗。`closeToTray` 為真時，關閉主視窗只隱藏（仍走既有 closeGate flush 流程後再 hide，不 destroy）；`window-all-closed` 不結束。「結束」才真正 quit。
6. **通知（`notify.ts`）**：`Notification`；`error` 一律顯示，`matchStart`／`matchEnd` 依 `notifyMatch`，`finalized` 顯示「已儲存：檔名」，`diskWarn` 顯示。
7. **打包**：`scripts/build.ps1` 加 `cargo build --release`（`recorder/`，設定 `ADITORREC_FFMPEG_DIR`）並把 `aditorrec.exe` 複製到 `build/ffmpeg/bin/`（electron-builder 既有的 `ffmpeg` extraResources 會帶走）；不需改 `electron-builder.yml` 時就不要改。
8. **測試**：paths、tray 選單狀態對應（把 Electron Tray/Menu 抽象成可注入）、closeToTray 行為、單一執行個體、`--hidden`。最後手動清單寫進報告（需要使用者實機驗證的項目）。
